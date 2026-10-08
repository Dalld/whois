/**
 * 文件：src/lib/pricing/porkbun-tld.ts
 * 用途：从 Porkbun 官方定价页抓取**后缀级**价格
 *
 * ## 为什么抓页而不是用 API
 *
 * 我们的域名级 adapter（`porkbun.ts`）用的是官方 `checkDomain` 接口，
 * 一次只能查一个域名、上限 25 个，且有限流。
 * 而定价页一次返回**全部 600+ 个后缀**的挂牌价，覆盖面无可比性。
 *
 * 官方在 robots.txt 里明确允许抓取本页（只 Disallow 了 `/api/*`、`/checkout/*`
 * 等路径），因此这是正当抓取，不是绕过访问控制。
 *
 * ## 数据形态
 *
 * 该页把价目表直接渲染为文本，形如：
 *
 *     .you $24.39 1st Yr Sale! $ 16.50 $ 18.54 $ 18.54
 *     .zip $ 10.81 $ 10.81 $ 10.81
 *
 * 即：`.tld 首年价 [1st Yr Sale! 标准价] 续费价 转移价`
 * 促销与不促销的字段数不同，正则需把促销段设为可选。
 *
 * 页面结构一旦改版，本模块会失效——因此解析失败时**必须报错**，
 * 不能静默返回空列表，否则会被误认为「该注册商没有报价」。
 */

import type { TldPrice, TldPriceSourceAdapter } from './tld-types'
import { normalizeTld } from './tld-types'

const PRICING_URL = 'https://porkbun.com/products/domains/pricing'
const USER_AGENT =
  'Mozilla/5.0 (compatible; whois-tld-compare/1.0; +https://github.com/Dalld/whois)'
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 匹配一条价目。
 *
 * 页面列头为 `extension | registration | renewal | transfer`，实际形态：
 *
 *   常规： .abogado $ 26.26 $ 26.26 $ 26.26
 *   促销： .academy $37.59 1st Yr Sale! $ 11.84 $ 37.59 $ 37.59
 *
 * 注意促销行的语义：`$37.59` 是**标准注册价**，
 * `1st Yr Sale!` 之后的 `$11.84` 才是**促销后的首年价**。
 * 随后的两个数字是标准续费价与转移价（促销不影响续费）。
 *
 * 即字段顺序为：标准注册价 [促销首年价] 续费价 转移价
 *
 * TLD 部分必须允许**内部点号**，否则 `.ac.nz` 会被截成 `nz`，
 * 与真正的 `.nz` 冲突并静默丢失两段式后缀。
 */
const PRICE_ROW_RE =
  /\.([a-z0-9\u00a1-\uffff](?:[a-z0-9\u00a1-\uffff.-]{0,62}[a-z0-9\u00a1-\uffff])?)\s+\$?\s*([\d,]+\.\d{2})(?:\s+1st Yr Sale!\s+\$\s*([\d,]+\.\d{2}))?\s+\$\s*([\d,]+\.\d{2})\s+\$\s*([\d,]+\.\d{2})/g

/** 去掉 script/style，把标签压成空格，便于正则匹配 */
function toPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
}

function toNumber(raw: string | undefined): number | null {
  if (!raw) return null
  const n = Number.parseFloat(raw.replace(/,/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * 解析定价页 HTML，返回后缀价格列表。
 * 导出以便用固定样本做单元测试，无需联网。
 */
export function parsePorkbunPricing(html: string, fetchedAt = new Date().toISOString()): TldPrice[] {
  const text = toPlainText(html)
  const seen = new Map<string, TldPrice>()
  PRICE_ROW_RE.lastIndex = 0

  let m: RegExpExecArray | null
  while ((m = PRICE_ROW_RE.exec(text)) !== null) {
    const tld = normalizeTld(m[1])
    if (!tld || tld.length > 63) continue

    // 分组语义：2=标准注册价，3=促销首年价（可选），4=续费价，5=转移价
    const standardRegister = toNumber(m[2])
    const saleRegister = toNumber(m[3])
    const renew = toNumber(m[4])
    const transfer = toNumber(m[5])

    const onSale = saleRegister !== null
      && standardRegister !== null
      && saleRegister < standardRegister

    const entry: TldPrice = {
      tld,
      registrar: 'porkbun',
      registrarName: 'Porkbun',
      // 注册价取用户实际支付的首年价：促销时用促销价
      register: onSale ? saleRegister : standardRegister,
      renew,
      transfer,
      // 标准注册价，供界面显示删除线原价
      regularRegister: standardRegister,
      onSale,
      currency: 'USD',
      source: 'crawled',
      website: 'https://porkbun.com',
      fetchedAt,
    }

    // 同一 TLD 可能出现多次（如普通与 IDN 区块），保留续费价更低的一条
    const prev = seen.get(tld)
    if (!prev) {
      seen.set(tld, entry)
    } else {
      const prevKey = prev.renew ?? Number.POSITIVE_INFINITY
      const nextKey = entry.renew ?? Number.POSITIVE_INFINITY
      if (nextKey < prevKey) seen.set(tld, entry)
    }
  }

  return [...seen.values()].sort((a, b) => a.tld.localeCompare(b.tld))
}

export class PorkbunTldSource implements TldPriceSourceAdapter {
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
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new Error(`Porkbun 定价页请求失败：HTTP ${res.status}`)
      }

      const html = await res.text()
      const prices = parsePorkbunPricing(html)

      // 解析失败必须报错，否则会被误认为「没有报价」
      if (prices.length === 0) {
        throw new Error(
          'Porkbun 定价页解析结果为空，页面结构可能已改版',
        )
      }
      return prices
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }
}
