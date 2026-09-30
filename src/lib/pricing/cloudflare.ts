/**
 * 文件：src/lib/pricing/cloudflare.ts
 * 用途：Cloudflare Registrar 报价 adapter
 *
 * 接口：POST /accounts/{account_id}/registrar/domain-check
 * 文档：https://developers.cloudflare.com/registrar/registrar-api/
 *
 * 为什么这家值得优先接入：
 * Cloudflare 以**注册局成本价**销售域名、不加价，因此它的报价天然是
 * 「价格下限基准」。用户看到这个数字，就能判断别家的溢价是否合理。
 *
 * 返回结构（依据官方 API reference）：
 *   result.domains[] {
 *     name              域名的 punycode 形式
 *     registrable       是否可注册（直连注册局的实时结果）
 *     tier              "standard" | "premium"
 *     pricing {         registrable 为 true 时才有
 *       currency           ISO-4217，如 "USD"
 *       registration_cost  首年价（字符串，保留小数精度）
 *       renewal_cost       续费价（字符串）
 *     }
 *     reason            registrable 为 false 时的原因
 *   }
 *
 * 重要提示：
 * - Search 端点用的是缓存数据，**不是**权威来源；本 adapter 只用 Check
 * - 单次最多 20 个域名，超出的由调用方分批
 * - 注册接口是真实扣费且不可退款，比价场景**绝不**调用注册端点
 * - 该 API 为 beta，官方明确「续费与转移暂不支持」，因此 renew 用
 *   renewal_cost 表达（那是「续费价格」而非「发起续费操作」）
 */

import { extractTld, makeQuote, type RegistrarAdapter, type RegistrarQuote, type QuoteSource } from './types'

const BASE_URL = 'https://api.cloudflare.com/client/v4'
/** 官方限制：单次 Check 最多 20 个域名 */
export const CLOUDFLARE_CHECK_LIMIT = 20

export interface CloudflareCredentials {
  accountId?: string
  apiToken?: string
}

interface DomainEntry {
  name?: string
  registrable?: boolean
  tier?: 'standard' | 'premium'
  reason?: string
  pricing?: {
    currency?: string
    registration_cost?: string
    renewal_cost?: string
  }
}

interface CheckResponse {
  success?: boolean
  errors?: { code?: number; message?: string }[]
  result?: { domains?: DomainEntry[] }
}

/** 官方文档列出的常见原因，用于生成可读的错误信息 */
const REASON_TEXT: Record<string, string> = {
  domain_unavailable: '域名已被注册',
  extension_not_supported_via_api: '该后缀暂不支持通过 API 查询',
  extension_not_supported: 'Cloudflare 不支持该后缀',
  extension_disallows_registration: '该后缀的注册局暂停了新注册',
  domain_premium: '溢价域名，API 暂不支持',
}

export function describeReason(reason: string | undefined): string {
  if (!reason) return '不可注册'
  return REASON_TEXT[reason] ?? reason
}

export class CloudflareAdapter implements RegistrarAdapter {
  readonly id = 'cloudflare'
  readonly name = 'Cloudflare'
  private readonly creds: CloudflareCredentials
  private readonly source: QuoteSource

  constructor(creds: CloudflareCredentials = {}) {
    this.creds = creds
    // 缺任一凭证即视为不可用：Cloudflare 没有 mock 端点，
    // 因此由 isConfigured 让上层跳过，而不是发出必然失败的请求。
    this.source = 'live'
  }

  /** 是否已配置凭证。未配置时上层应跳过该 adapter */
  get isConfigured(): boolean {
    return Boolean(this.creds.accountId && this.creds.apiToken)
  }

  async fetchQuote(domain: string, options: { signal?: AbortSignal } = {}): Promise<RegistrarQuote> {
    const results = await this.fetchQuotes([domain], options)
    const quote = results[0]
    if (!quote) throw new Error('Cloudflare 未返回该域名的结果')
    return quote
  }

  /**
   * 批量查询，单次最多 20 个域名。
   * 超过上限时自动分批，避免调用方关心这个限制。
   */
  async fetchQuotes(domains: string[], options: { signal?: AbortSignal } = {}): Promise<RegistrarQuote[]> {
    if (!this.isConfigured) {
      throw new Error('Cloudflare 未配置 accountId / apiToken')
    }

    const normalized = domains.map(d => d.trim().toLowerCase())
    const out: RegistrarQuote[] = []

    for (let i = 0; i < normalized.length; i += CLOUDFLARE_CHECK_LIMIT) {
      const batch = normalized.slice(i, i + CLOUDFLARE_CHECK_LIMIT)
      const entries = await this.checkBatch(batch, options)
      for (const entry of entries) {
        const quote = this.normalize(entry)
        if (quote) out.push(quote)
      }
    }

    return out
  }

  /** 调用一次 Check 端点 */
  private async checkBatch(domains: string[], options: { signal?: AbortSignal }): Promise<DomainEntry[]> {
    const url = `${BASE_URL}/accounts/${encodeURIComponent(this.creds.accountId!)}/registrar/domain-check`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.creds.apiToken!}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ domains }),
      signal: options.signal,
    })

    if (!res.ok) {
      // 尽量把 Cloudflare 的错误详情带出来，否则只剩一个状态码很难排查
      let detail = ''
      try {
        const body = (await res.json()) as CheckResponse
        const first = body.errors?.[0]
        if (first?.message) detail = `：${first.message}`
      } catch { /* 响应非 JSON，忽略 */ }
      throw new Error(`Cloudflare 返回 HTTP ${res.status}${detail}`)
    }

    const data = (await res.json()) as CheckResponse
    if (data.success === false) {
      const first = data.errors?.[0]
      throw new Error(first?.message ? `Cloudflare 错误：${first.message}` : 'Cloudflare 返回 success=false')
    }
    return data.result?.domains ?? []
  }

  /** 把 Cloudflare 的条目映射到统一结构 */
  private normalize(entry: DomainEntry): RegistrarQuote | null {
    const name = entry.name?.trim().toLowerCase()
    if (!name) return null

    const registrable = entry.registrable === true
    const premium = entry.tier === 'premium'
    const pricing = entry.pricing

    // registration_cost 与 renewal_cost 都是字符串，交由 parsePrice 处理。
    // 续费价没有独立的「促销」标记，由价格差自动判定。
    const register = makeQuote(pricing?.registration_cost, pricing?.registration_cost)
    const renew = makeQuote(pricing?.renewal_cost, pricing?.renewal_cost)

    return {
      registrar: this.id,
      registrarName: this.name,
      domain: name,
      tld: extractTld(name),
      // registrable 为 false 时 pricing 缺失，此时仍返回条目，
      // 让上层能用 reason 告诉用户「为什么查不到价格」，而不是静默消失。
      available: registrable,
      premium,
      currency: 'USD',
      register,
      renew,
      // 官方明确 transfers 暂不支持 API，故不提供转移价
      transfer: null,
      minDuration: null,
      fetchedAt: new Date().toISOString(),
      source: this.source,
      raw: entry.reason ? { reason: entry.reason, reasonText: describeReason(entry.reason) } : undefined,
    }
  }
}
