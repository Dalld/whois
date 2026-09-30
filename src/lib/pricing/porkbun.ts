/**
 * 文件：src/lib/pricing/porkbun.ts
 * 用途：Porkbun 报价 adapter
 *
 * 接口：POST /domain/checkDomain/{domain}（单个）
 *       POST /domain/checkDomain（批量，最多 25 个）
 * 文档：https://porkbun.com/api/json/v3/documentation
 *
 * 返回字段（依据官方 OpenAPI spec 与 /mock 端点实测）：
 *   response.avail          "yes" | "no"
 *   response.price          注册价，可能是首年促销价
 *   response.regularPrice   注册标准价
 *   response.firstYearPromo "yes" | "no"
 *   response.premium        "yes" | "no"
 *   response.minDuration    注册局要求的最短年限
 *   response.additional.renewal  { price, regularPrice }
 *   response.additional.transfer { price, regularPrice }
 *
 * 认证：X-API-Key / X-Secret-API-Key 请求头。
 * 未配置密钥时回落到 mock 端点，返回结构一致的示例数据，
 * 便于在没有账号的情况下开发与测试。
 */

import { extractTld, makeQuote, parseYesNo, type RegistrarAdapter, type RegistrarQuote, type QuoteSource } from './types'

const BASE_URL = 'https://api.porkbun.com/api/json/v3'
/** 官方限制：10 秒内最多 10 次查询 */
export const PORKBUN_BULK_LIMIT = 25

export interface PorkbunCredentials {
  apiKey?: string
  secretApiKey?: string
}

interface CheckDomainResponse {
  status?: string
  response?: {
    avail?: string
    type?: string
    price?: string
    firstYearPromo?: string
    regularPrice?: string
    premium?: string
    minDuration?: number
    additional?: {
      renewal?: { type?: string; price?: string; regularPrice?: string }
      transfer?: { type?: string; price?: string; regularPrice?: string }
    }
  }
  message?: string
}

/** sandbox key 以 pk1_sb_ 开头 */
function resolveSource(creds: PorkbunCredentials): QuoteSource {
  if (!creds.apiKey || !creds.secretApiKey) return 'mock'
  return creds.apiKey.startsWith('pk1_sb_') ? 'sandbox' : 'live'
}

export class PorkbunAdapter implements RegistrarAdapter {
  readonly id = 'porkbun'
  readonly name = 'Porkbun'
  private readonly creds: PorkbunCredentials
  private readonly source: QuoteSource

  constructor(creds: PorkbunCredentials = {}) {
    this.creds = creds
    this.source = resolveSource(creds)
  }

  async fetchQuote(domain: string, options: { signal?: AbortSignal } = {}): Promise<RegistrarQuote> {
    const normalized = domain.trim().toLowerCase()
    // mock 模式无需密钥，直接命中官方的 schema 示例端点
    const path = this.source === 'mock'
      ? `${BASE_URL}/mock/domain/checkDomain/${encodeURIComponent(normalized)}`
      : `${BASE_URL}/domain/checkDomain/${encodeURIComponent(normalized)}`

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.source !== 'mock') {
      headers['X-API-Key'] = this.creds.apiKey!
      headers['X-Secret-API-Key'] = this.creds.secretApiKey!
    }

    const res = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
      signal: options.signal,
    })

    if (!res.ok) {
      throw new Error(`Porkbun 返回 HTTP ${res.status}`)
    }

    const data = (await res.json()) as CheckDomainResponse
    if (data.status && data.status !== 'SUCCESS') {
      throw new Error(data.message || `Porkbun 返回状态 ${data.status}`)
    }
    if (!data.response) {
      throw new Error('Porkbun 响应缺少 response 字段')
    }

    return this.normalize(normalized, data)
  }

  /** 把 Porkbun 响应映射到统一结构 */
  private normalize(domain: string, data: CheckDomainResponse): RegistrarQuote {
    const r = data.response!
    const additional = r.additional ?? {}

    return {
      registrar: this.id,
      registrarName: this.name,
      domain,
      tld: extractTld(domain),
      available: parseYesNo(r.avail),
      premium: parseYesNo(r.premium),
      currency: 'USD',
      register: makeQuote(r.price, r.regularPrice, parseYesNo(r.firstYearPromo) || undefined),
      // 续费与转移没有独立的促销标记，由价格差自动判定
      renew: makeQuote(additional.renewal?.price, additional.renewal?.regularPrice),
      transfer: makeQuote(additional.transfer?.price, additional.transfer?.regularPrice),
      minDuration: typeof r.minDuration === 'number' ? r.minDuration : null,
      fetchedAt: new Date().toISOString(),
      source: this.source,
    }
  }
}
