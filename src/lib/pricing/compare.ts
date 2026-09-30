/**
 * 文件：src/lib/pricing/compare.ts
 * 用途：把多个注册商的报价聚合为一次比价结果
 *
 * 排序策略：按「续费价」而非「首年价」排序。
 * 首年价常被注册商用于引流（如 $0.99 首年、$30 续费），
 * 用它排序会得出误导性的「最便宜」结论。
 */

import type { PriceComparison, RegistrarAdapter, RegistrarQuote } from './types'
import { extractTld } from './types'

/** 取用于排序的价格：优先续费价，缺失时回落首年价 */
export function sortPrice(q: RegistrarQuote): number {
  const renew = q.renew?.price
  if (typeof renew === 'number' && renew > 0) return renew
  const register = q.register?.price
  if (typeof register === 'number' && register > 0) return register
  return Number.POSITIVE_INFINITY
}

/**
 * 并发查询多个注册商并聚合结果。
 * 单个注册商失败不影响整体：错误被收集到 errors，其余报价照常返回。
 */
export async function comparePrices(
  domain: string,
  adapters: RegistrarAdapter[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<PriceComparison> {
  const normalized = domain.trim().toLowerCase()
  const timeoutMs = options.timeoutMs ?? 10_000

  const results = await Promise.allSettled(
    adapters.map(async adapter => {
      // 单个注册商超时不应拖慢整体
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const onAbort = () => controller.abort()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        return await adapter.fetchQuote(normalized, { signal: controller.signal })
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }
    }),
  )

  const quotes: RegistrarQuote[] = []
  const errors: { registrar: string; message: string }[] = []

  results.forEach((result, i) => {
    const adapter = adapters[i]
    if (result.status === 'fulfilled') {
      quotes.push(result.value)
    } else {
      const reason = result.reason
      errors.push({
        registrar: adapter.id,
        message: reason instanceof Error ? reason.message : String(reason),
      })
    }
  })

  // 按续费价升序；价格相同则按注册商名稳定排序，避免顺序抖动
  quotes.sort((a, b) => {
    const diff = sortPrice(a) - sortPrice(b)
    if (diff !== 0) return diff
    return a.registrar.localeCompare(b.registrar)
  })

  return {
    domain: normalized,
    tld: extractTld(normalized),
    quotes,
    cheapest: quotes.length > 0 ? quotes[0] : null,
    errors,
    queriedAt: new Date().toISOString(),
  }
}
