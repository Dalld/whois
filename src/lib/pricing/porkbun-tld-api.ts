/**
 * 文件：src/lib/pricing/porkbun-tld-api.ts
 * 用途：Porkbun 官方**公开**后缀价目接口
 *
 * `GET https://api.porkbun.com/api/json/v3/pricing/get`
 *
 * 这是**无需认证**的公开端点，一次返回 900+ 个后缀的
 * registration / renewal / transfer 价格，结构为 JSON。
 * （注意：与我们已用的 `domain/checkDomain` 不同，后者需要 API key
 * 且一次只能查一个域名。）
 *
 * ## 为什么优先用接口而不是抓页
 *
 * 同一个数据源，`porkbun-tld.ts` 抓定价页可解析出 600+ 后缀，
 * 本接口返回 900+，且：
 * - 结构化 JSON，不受页面改版影响
 * - 官方端点，有明确的响应契约
 * - 体积更小、更快
 *
 * 抓页实现保留作为兜底（接口若下线可切回），但默认走本模块。
 *
 * ## 响应结构
 *
 * ```json
 * { "status": "SUCCESS",
 *   "pricing": { "cx": { "registration": "16.53", "renewal": "16.75",
 *                        "transfer": "16.53", "coupons": [] }, ... } }
 * ```
 *
 * 价格为**字符串**（官方为保留小数精度），币种 USD。
 * 未售卖的后缀不在 `pricing` 中。
 */

import type { TldPrice, TldPriceSourceAdapter } from './tld-types'

const PRICING_URL = 'https://api.porkbun.com/api/json/v3/pricing/get'
const USER_AGENT =
  'Mozilla/5.0 (compatible; whois-tld-compare/1.0; +https://github.com/Dalld/whois)'
const DEFAULT_TIMEOUT_MS = 30_000

interface PorkbunPricingEntry {
  registration?: string | number
  renewal?: string | number
  transfer?: string | number
  coupons?: unknown[]
}

interface PorkbunPricingResponse {
  status?: string
  pricing?: Record<string, PorkbunPricingEntry>
  unsupported?: string[]
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
  if (typeof value !== 'string') return null
  const n = Number.parseFloat(value.replace(/,/g, ''))
  // 0 视为「不支持」而非「免费」
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * 把接口响应转成统一的 TldPrice 列表。
 * 导出以便用固定样本做单元测试，无需联网。
 */
export function parsePorkbunPricingApi(
  payload: PorkbunPricingResponse,
  fetchedAt = new Date().toISOString(),
): TldPrice[] {
  const pricing = payload.pricing
  if (!pricing || typeof pricing !== 'object') return []

  const out: TldPrice[] = []
  for (const [rawTld, entry] of Object.entries(pricing)) {
    if (!entry || typeof entry !== 'object') continue
    const tld = rawTld.toLowerCase().replace(/^\.+/, '').trim()
    if (!tld || tld.length > 63) continue

    const register = toNumber(entry.registration)
    const renew = toNumber(entry.renewal)
    // 全无价格则跳过，避免写入无意义的空条目
    if (register === null && renew === null) continue

    out.push({
      tld,
      registrar: 'porkbun',
      registrarName: 'Porkbun',
      register,
      renew,
      transfer: toNumber(entry.transfer),
      // 该接口不区分促销与标准价，故两者一致
      regularRegister: register,
      onSale: false,
      currency: 'USD',
      source: 'api',
      website: 'https://porkbun.com',
      fetchedAt,
    })
  }

  return out.sort((a, b) => a.tld.localeCompare(b.tld))
}

export class PorkbunTldApiSource implements TldPriceSourceAdapter {
  readonly id = 'porkbun'
  readonly name = 'Porkbun'
  readonly website = 'https://porkbun.com'

  async fetchAll(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<TldPrice[]> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS } = options
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetch(PRICING_URL, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new Error(`Porkbun 价目接口失败：HTTP ${res.status}`)
      }

      const json = (await res.json()) as PorkbunPricingResponse
      if (json.status && json.status !== 'SUCCESS') {
        throw new Error(`Porkbun 价目接口返回 ${json.status}`)
      }

      const prices = parsePorkbunPricingApi(json)
      // 解析为空必须报错，否则会被误认为「该注册商没有报价」
      if (prices.length === 0) {
        throw new Error('Porkbun 价目接口返回中没有可用价格，响应结构可能已变更')
      }
      return prices
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }
}
