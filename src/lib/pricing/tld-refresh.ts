/**
 * 文件：src/lib/pricing/tld-refresh.ts
 * 用途：后缀价目表的整表刷新与比价
 *
 * 刷新策略与域名级（`refresh.ts`）不同：
 * - 域名级是「按域名逐个问」，需要节流、退避、限流避让
 * - 后缀级是「整表下载」，每个数据源一次请求即可，故只需
 *   并发控制与失败隔离
 */

import type { TldPrice, TldPriceSourceAdapter, TldComparison } from './tld-types'
import { sortKey, tldCandidates, normalizeTld } from './tld-types'
import type { TldPriceStore } from './tld-store'

export interface RefreshResult {
  /** 成功刷新的数据源 */
  refreshed: { source: string; count: number }[]
  /** 失败的数据源及原因 */
  errors: { source: string; message: string }[]
}

/**
 * 刷新指定数据源的全部后缀价并写入缓存。
 *
 * 单个数据源失败不影响其他：整表抓取失败往往是对方页面改版或临时故障，
 * 此时应保留旧数据继续服务，而不是清空。
 */
export async function refreshTldSources(
  adapters: TldPriceSourceAdapter[],
  store: TldPriceStore,
  options: {
    timeoutMs?: number
    only?: string[]
    onProgress?: (e: { type: 'start' | 'done' | 'failed'; source: string; count?: number; message?: string }) => void
  } = {},
): Promise<RefreshResult> {
  const { timeoutMs = 30_000, only, onProgress } = options
  const targets = only ? adapters.filter(a => only.includes(a.id)) : adapters

  const result: RefreshResult = { refreshed: [], errors: [] }

  await Promise.all(targets.map(async adapter => {
    onProgress?.({ type: 'start', source: adapter.id })
    try {
      const prices = await adapter.fetchAll({ timeoutMs })
      const count = store.saveAll(adapter.id, prices)
      result.refreshed.push({ source: adapter.id, count })
      onProgress?.({ type: 'done', source: adapter.id, count })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.errors.push({ source: adapter.id, message })
      onProgress?.({ type: 'failed', source: adapter.id, message })
    }
  }))

  return result
}

/** 只刷新已过期的数据源。全部新鲜时不发任何请求 */
export async function refreshStaleTldSources(
  adapters: TldPriceSourceAdapter[],
  store: TldPriceStore,
  options: Parameters<typeof refreshTldSources>[2] = {},
): Promise<RefreshResult> {
  const stale = store.staleSources(adapters.map(a => a.id))
  if (stale.length === 0) return { refreshed: [], errors: [] }
  return refreshTldSources(adapters, store, { ...options, only: stale })
}

/**
 * 比价：给定域名或后缀，从缓存中取出各家报价并排序。
 *
 * **只读缓存，不触发抓取。** 缓存为空时应先跑刷新（CLI 或定时任务）。
 * 这样用户查询零外连，也就不会被注册商限流。
 */
export function compareTld(
  store: TldPriceStore,
  input: string,
  options: { adapters?: TldPriceSourceAdapter[] } = {},
): TldComparison {
  const raw = input.trim().toLowerCase()
  // 允许直接传后缀（cx / .cx）或完整域名（feng.cx）
  const candidates = raw.includes('.') && !raw.startsWith('.')
    ? tldCandidates(raw)
    : [normalizeTld(raw), ...[]]

  const hit = store.findTld(candidates.length > 0 ? candidates : [normalizeTld(raw)])
  const fetchedAt = new Date().toISOString()

  if (!hit) {
    return {
      tld: candidates[0] ?? normalizeTld(raw),
      quotes: [],
      cheapest: null,
      missing: options.adapters?.map(a => a.id) ?? [],
      errors: [],
      fetchedAt,
    }
  }

  const quotes = [...hit.prices].sort((a, b) => {
    const d = sortKey(a) - sortKey(b)
    // 同价按注册商名稳定排序，避免每次刷新顺序抖动
    return d !== 0 ? d : a.registrarName.localeCompare(b.registrarName)
  })

  const known = new Set(quotes.map(q => q.registrar))
  const missing = (options.adapters?.map(a => a.id) ?? []).filter(id => !known.has(id))

  return {
    tld: hit.tld,
    quotes,
    cheapest: quotes.length > 0 ? quotes[0] : null,
    missing,
    errors: [],
    fetchedAt,
  }
}

/** 便捷函数：直接从一组报价里找某后缀的最低价 */
export function cheapestFor(prices: TldPrice[], tld: string): TldPrice | null {
  const t = normalizeTld(tld)
  const hit = prices.filter(p => p.tld === t)
  if (hit.length === 0) return null
  return hit.reduce((best, p) => (sortKey(p) < sortKey(best) ? p : best))
}
