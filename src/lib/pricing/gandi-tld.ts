/**
 * 文件：src/lib/pricing/gandi-tld.ts
 * 用途：Gandi 的**逐后缀**价目抓取（补 Porkbun 未收录的国别后缀）
 *
 * ## 为什么需要这个模块
 *
 * Porkbun 的整表价目覆盖 910 个后缀，但不卖 `.al` / `.im` 等。
 * Gandi 可抓且价格有竞争力（`.im` 注册 $20.00）。
 *
 * ## 页面结构（实测）
 *
 * Gandi 的后缀页把价格按标签成组渲染，剥掉标签后形如：
 *
 * ```
 * .im domain prices | Registration | $20.00 | per year | For 1 to 2 years
 *                   | Transfer | Free | ...
 *                   | Renewal | $39.98 | per year
 * ```
 *
 * **注意注册价与续费价差别很大**（.im：$20.00 对 $39.98），
 * 所以必须按标签取值，不能用「出现次数最多」这类启发式——
 * 页面上还混有其他扩展名与附加服务的价格（$600.00、$2,00、$6,00 等），
 * 频率法会取错。
 *
 * robots.txt 允许抓取 /en-US/domain/tld/*（仅屏蔽带 query 的内部跳转路径）。
 */

import type { TldPrice, TldPriceSourceAdapter } from './tld-types'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const TIMEOUT_MS = 20_000

/**
 * 已知 Gandi 有售的后缀。
 *
 * 实测 69 个常见后缀中 68 个可解析出价格（`.ru` 无价）。
 * 这个清单是**逐后缀抓取**的抓取范围：每个后缀一次请求，
 * 因此不能无限扩张——每次刷新会发 68 个请求，
 * 保守加 200ms 间隔以避免给对方造成压力。
 *
 * 需要增删后缀时直接改这里；不在此清单中的后缀不会抓取。
 */
const GANDI_TLDS: string[] = [
  // 通用
  'com', 'net', 'org', 'info', 'biz', 'xyz', 'online', 'site', 'store', 'tech', 'dev', 'app', 'ai',
  // 常见 ccTLD / 国别
  'io', 'co', 'me', 'cc', 'tv', 'fm', 'sh', 'ly', 'nu', 'ws', 'ac', 'uk', 'de', 'fr', 'nl', 'it',
  'es', 'se', 'no', 'fi', 'dk', 'be', 'ch', 'at', 'pl', 'cz', 'jp', 'cn', 'hk', 'sg', 'in', 'au',
  'nz', 'ca', 'br', 'mx', 'za', 'kr', 'tw', 'id', 'my', 'th', 'vn', 'ph', 'tr', 'il', 'ae', 'sa', 'eg',
  // 此前专门补齐的（Porkbun 未收录）
  'al', 'im', 'gg', 'je', 'to', 'cx',
]

/** 后缀 → Gandi 页面路径（路径即后缀本身，保留映射便于将来处理特例） */
function gandiPath(tld: string): string {
  return tld
}

const MONEY = String.raw`\$\s?[\d,]+(?:\.\d{2})?`

/** 从 "$1,234.56" 解析为数字；返回 null 表示无有效价格 */
function money(token: string | undefined): number | null {
  if (!token) return null
  const n = Number.parseFloat(token.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * 从 Gandi 后缀页解析价格。
 *
 * 按标签锚定：
 * - `Registration` 后第一个金额 → 注册价
 * - `Renewal` 后第一个金额 → 续费价
 * - `Transfer` 后若是 `Free` 则记 null（免费转入不等于 0 元注册）
 *
 * 若连注册价都取不到，返回 null（宁可没有报价，也不要错误报价）。
 */
export function parseGandiPage(html: string, tld: string, fetchedAt = new Date().toISOString()): TldPrice | null {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '|')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\|+/g, '|')
    .replace(/\s+/g, ' ')

  /**
   * 价格表的起点：`<tld> domain prices`。
   *
   * **必须从这里开始找标签**，不能直接 indexOf('Registration')——
   * 页面前面的说明文字里也会出现 "registration"（如
   * "The minimum registration period is one year"），
   * 直接搜标签会命中正文，导致取不到价格。
   */
  const tableStart = (() => {
    // 允许 "domain prices" 前后有标签分隔符（剥标签后可能残留 `|`）
    const m = text.match(/domain prices/i)
    return m ? m.index! + m[0].length : -1
  })()
  if (tableStart === -1) return null

  const tableText = text.slice(tableStart)

  /**
   * 取标签之后的第一个金额。
   *
   * 剥标签后形如 `Registration|$20.00|per year`；标签与金额之间
   * 可能隔着空单元格（`.im` 为 `Transfer|Free`）。
   * 向后取窗口时遇到下一个已知标签即截断，
   * 避免把 Renewal 的价格当成 Registration 的。
   */
  const firstMoneyAfter = (label: string): { value: number | null; free: boolean } => {
    const idx = tableText.toLowerCase().indexOf(label.toLowerCase())
    if (idx === -1) return { value: null, free: false }

    const window = tableText.slice(idx + label.length, idx + label.length + 200)
    const stop = window.search(/Registration|Renewal|Transfer/i)
    const seg = stop === -1 ? window : window.slice(0, stop)

    // "Free" 表示免费转入——不等于 0 元，调用方据此记 null
    if (/^\s*\|?\s*free\b/i.test(seg)) return { value: null, free: true }

    const m = seg.match(new RegExp(MONEY))
    return { value: money(m?.[0]), free: false }
  }

  const reg = firstMoneyAfter('Registration')
  const ren = firstMoneyAfter('Renewal')
  const tra = firstMoneyAfter('Transfer')

  const register = reg.value
  const renew = ren.value
  // 免费转入记 null 而非 0
  const transfer = tra.free ? null : tra.value

  // 连注册价都没有，说明该后缀在 Gandi 无售或页面已改版
  if (register === null) return null

  return {
    tld,
    registrar: 'gandi',
    registrarName: 'Gandi',
    register,
    renew,
    transfer,
    regularRegister: register,
    onSale: false,
    currency: 'USD',
    source: 'crawled',
    website: 'https://www.gandi.net',
    fetchedAt,
  }
}

/**
 * 逐后缀抓取 Gandi。
 *
 * 与 Netim 同样的失败处理原则：单后缀失败跳过，
 * 但全部失败时抛错，避免把「被拦截」伪装成「无报价」。
 */
export class GandiTldSource implements TldPriceSourceAdapter {
  readonly id = 'gandi'
  readonly name = 'Gandi'
  readonly website = 'https://www.gandi.net'

  lastErrors: { tld: string; message: string }[] = []

  async fetchAll(options: { signal?: AbortSignal; timeoutMs?: number; tlds?: string[]; delayMs?: number } = {}): Promise<TldPrice[]> {
    const tlds = options.tlds ?? GANDI_TLDS
    const out: TldPrice[] = []
    this.lastErrors = []

    for (const tld of tlds) {
      const path = gandiPath(tld)
      if (!path) continue

      const controller = new AbortController()
      const onAbort = () => controller.abort()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS)

      try {
        const res = await fetch(`https://www.gandi.net/en-US/domain/tld/${path}`, {
          headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
          signal: controller.signal,
        })
        if (!res.ok) {
          this.lastErrors.push({ tld, message: `HTTP ${res.status}` })
        } else {
          const price = parseGandiPage(await res.text(), tld)
          if (price) out.push(price)
          else this.lastErrors.push({ tld, message: '页面中未找到 Registration 价格' })
        }
      } catch (error) {
        this.lastErrors.push({ tld, message: error instanceof Error ? error.message : '抓取失败' })
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }

      // 逐后缀抓取，请求数等于后缀数。加一个小间隔，
      // 避免对 Gandi 造成不必要的并发压力。
      const delay = options.delayMs ?? 200
      if (delay > 0) await new Promise(r => setTimeout(r, delay))
    }

    // 全部失败说明是数据源级故障（被拦截、改版、网络不通），
    // 抛错以便上层保留旧数据并告警，而不是把已有数据清空
    if (out.length === 0 && this.lastErrors.length > 0) {
      const detail = this.lastErrors.slice(0, 3).map(e => `.${e.tld}: ${e.message}`).join('；')
      throw new Error(`Gandi 全部后缀抓取失败（${detail}${this.lastErrors.length > 3 ? ` 等 ${this.lastErrors.length} 项` : ''}）`)
    }

    return out
  }
}
