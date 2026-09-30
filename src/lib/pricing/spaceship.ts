/**
 * 文件：src/lib/pricing/spaceship.ts
 * 用途：Spaceship 报价 adapter
 *
 * 接口：POST /v1/domains/available（批量）
 *       GET  /v1/domains/{domain}/available（单个）
 * 文档：https://docs.spaceship.dev
 *
 * Spaceship 是 Namecheap 旗下品牌，常年以接近成本价销售，
 * 是除了 Cloudflare 之外最有价格参考价值的一家。
 *
 * 认证：X-Api-Key / X-Api-Secret 两个请求头。
 *
 * 返回结构：
 *   {
 *     "domains": [
 *       {
 *         "domain": "spaceship.dev",
 *         "result": "available" | "unavailable" | ...,
 *         "premiumPricing": [
 *           { "operation": "register", "price": 10.99, "currency": "USD" }
 *         ]
 *       }
 *     ]
 *   }
 *
 * premiumPricing 是**数组**，operation 取值 register / renew / transfer / restore。
 * 注意：普通（非溢价）域名也可能返回 premiumPricing，此时它表示该域名的
 * 标准报价；官方文档把它描述为「premium names」的字段，但实际用途更广，
 * 因此这里不依据它判断是否溢价，而由价格量级与 result 字段综合判断。
 */

import { extractTld, makeQuote, type RegistrarAdapter, type RegistrarQuote, type QuoteSource } from './types'

const BASE_URL = 'https://spaceship.dev/api/v1'

export interface SpaceshipCredentials {
  apiKey?: string
  apiSecret?: string
}

interface PricingEntry {
  operation?: string
  price?: number | string
  currency?: string
}

interface DomainEntry {
  domain?: string
  result?: string
  premiumPricing?: PricingEntry[]
}

interface AvailabilityResponse {
  domains?: DomainEntry[]
}

/** result 字段里表示「可注册」的取值 */
const AVAILABLE_RESULTS = new Set(['available'])

export class SpaceshipAdapter implements RegistrarAdapter {
  readonly id = 'spaceship'
  readonly name = 'Spaceship'
  private readonly creds: SpaceshipCredentials
  private readonly source: QuoteSource

  constructor(creds: SpaceshipCredentials = {}) {
    this.creds = creds
    this.source = 'live'
  }

  /** 是否已配置凭证。未配置时上层应跳过 */
  get isConfigured(): boolean {
    return Boolean(this.creds.apiKey && this.creds.apiSecret)
  }

  async fetchQuote(domain: string, options: { signal?: AbortSignal } = {}): Promise<RegistrarQuote> {
    const results = await this.fetchQuotes([domain], options)
    const quote = results[0]
    if (!quote) throw new Error('Spaceship 未返回该域名的结果')
    return quote
  }

  /** 批量查询（官方支持一次多个域名） */
  async fetchQuotes(domains: string[], options: { signal?: AbortSignal } = {}): Promise<RegistrarQuote[]> {
    if (!this.isConfigured) {
      throw new Error('Spaceship 未配置 apiKey / apiSecret')
    }

    const normalized = domains.map(d => d.trim().toLowerCase())
    const url = `${BASE_URL}/domains/available`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Api-Key': this.creds.apiKey!,
        'X-Api-Secret': this.creds.apiSecret!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ domains: normalized }),
      signal: options.signal,
    })

    if (!res.ok) {
      let detail = ''
      try {
        const body = (await res.json()) as { message?: string; detail?: string }
        detail = body.message || body.detail || ''
      } catch { /* 响应非 JSON，忽略 */ }
      throw new Error(`Spaceship 返回 HTTP ${res.status}${detail ? `：${detail}` : ''}`)
    }

    const data = (await res.json()) as AvailabilityResponse
    const entries = data.domains ?? []

    const out: RegistrarQuote[] = []
    for (const entry of entries) {
      const quote = this.normalize(entry)
      if (quote) out.push(quote)
    }
    return out
  }

  /** 从 premiumPricing 数组里按 operation 取价格 */
  private pick(entries: PricingEntry[] | undefined, operation: string): number | null {
    const hit = entries?.find(e => e.operation?.toLowerCase() === operation)
    if (!hit) return null
    const n = typeof hit.price === 'number' ? hit.price : Number.parseFloat(String(hit.price ?? ''))
    return Number.isFinite(n) ? n : null
  }

  private normalize(entry: DomainEntry): RegistrarQuote | null {
    const name = entry.domain?.trim().toLowerCase()
    if (!name) return null

    const result = (entry.result ?? '').toLowerCase()
    const available = AVAILABLE_RESULTS.has(result)
    const pricing = entry.premiumPricing

    const registerPrice = this.pick(pricing, 'register')
    const renewPrice = this.pick(pricing, 'renew')
    const transferPrice = this.pick(pricing, 'transfer')

    // 溢价判断：Spaceship 未直接给出标记。这里用「注册价远高于同后缀
    // 常见区间」无法可靠推断，因此采取保守策略——只要返回值明显偏离
    // 常规区间（$500 以上）即视为溢价，避免把 $1200 的域名当作普通价展示。
    const PREMIUM_THRESHOLD = 500
    const premium = (registerPrice ?? 0) >= PREMIUM_THRESHOLD || (renewPrice ?? 0) >= PREMIUM_THRESHOLD

    return {
      registrar: this.id,
      registrarName: this.name,
      domain: name,
      tld: extractTld(name),
      available,
      premium,
      currency: 'USD',
      register: makeQuote(registerPrice, registerPrice),
      renew: makeQuote(renewPrice, renewPrice),
      transfer: makeQuote(transferPrice, transferPrice),
      minDuration: null,
      fetchedAt: new Date().toISOString(),
      source: this.source,
      raw: entry.result ? { result: entry.result } : undefined,
    }
  }
}
