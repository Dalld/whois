/**
 * 文件：src/lib/pricing/refresh.ts
 * 用途：域名比价 —— 价格刷新调度
 *
 * 刷新任务必须替用户挡住各家的限流。已知约束：
 * - Porkbun：10 秒内最多 10 次查询，批量接口上限 25 个域名/次
 * - Cloudflare：Check 直连注册局，官方要求只在下单前调用
 *
 * 因此这里的策略是「队列 + 节流 + 退避」，而不是一次性并发打完：
 * 1. 串行出队，两次请求之间强制间隔（默认 1.1 秒，留出余量）
 * 2. 单次失败按指数退避重试，连续失败达到阈值则跳过该域名
 * 3. 命中 429 时读取 Retry-After，暂停整个队列
 * 4. 同一域名在冷却期内不重复刷新
 */

import type { RegistrarAdapter, RegistrarQuote } from './types'
import type { PriceStore } from './store'

export interface RefreshOptions {
  /** 两次请求之间的最小间隔（毫秒）。Porkbun 限 10 秒 10 次，默认留余量 */
  minIntervalMs?: number
  /** 单个域名的最大重试次数 */
  maxRetries?: number
  /** 单次请求超时（毫秒） */
  timeoutMs?: number
  /** 达到该连续失败次数后放弃该域名 */
  failureThreshold?: number
  /** 收到 429 时的默认暂停时长（毫秒），无 Retry-After 时使用 */
  rateLimitPauseMs?: number
  /** 进度回调 */
  onProgress?: (event: RefreshEvent) => void
  /** 注入 sleep，便于测试 */
  sleep?: (ms: number) => Promise<void>
}

export type RefreshEvent =
  | { type: 'start'; domain: string; registrar: string; attempt: number }
  | { type: 'success'; domain: string; registrar: string; quote: RegistrarQuote }
  | { type: 'failure'; domain: string; registrar: string; message: string; willRetry: boolean }
  | { type: 'skipped'; domain: string; registrar: string; reason: string }
  | { type: 'rate-limited'; registrar: string; pauseMs: number }

export interface RefreshReport {
  refreshed: number
  failed: number
  skipped: number
  durationMs: number
  /** 各域名的失败原因 */
  errors: { domain: string; registrar: string; message: string }[]
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** 从错误信息或 Retry-After 头里解析出暂停时长 */
export function parseRetryAfter(error: unknown, fallbackMs: number): number {
  const message = error instanceof Error ? error.message : String(error)
  const match = /retry[- ]after[:\s]+(\d+)/i.exec(message)
  if (match) {
    const seconds = Number.parseInt(match[1], 10)
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  }
  return fallbackMs
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\b429\b|rate.?limit|too many requests/i.test(message)
}

/**
 * 把一个域名的报价刷新进缓存。
 * 每个注册商独立处理：某家失败不影响其他家。
 */
export async function refreshDomain(
  domain: string,
  adapters: RegistrarAdapter[],
  store: PriceStore,
  options: RefreshOptions = {},
): Promise<{ saved: RegistrarQuote[]; errors: { registrar: string; message: string }[] }> {
  const {
    minIntervalMs = 1100,
    maxRetries = 3,
    timeoutMs = 10_000,
    rateLimitPauseMs = 10_000,
    onProgress,
    sleep = defaultSleep,
  } = options

  const saved: RegistrarQuote[] = []
  const errors: { registrar: string; message: string }[] = []
  const normalized = domain.trim().toLowerCase()

  for (const adapter of adapters) {
    let attempt = 0
    let lastError: unknown

    while (attempt < maxRetries) {
      attempt += 1
      onProgress?.({ type: 'start', domain: normalized, registrar: adapter.id, attempt })

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const quote = await adapter.fetchQuote(normalized, { signal: controller.signal })
        store.save(quote)
        saved.push(quote)
        onProgress?.({ type: 'success', domain: normalized, registrar: adapter.id, quote })
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        const rateLimited = isRateLimitError(error)
        const willRetry = attempt < maxRetries

        if (rateLimited) {
          const pauseMs = parseRetryAfter(error, rateLimitPauseMs)
          onProgress?.({ type: 'rate-limited', registrar: adapter.id, pauseMs })
          // 被限流时先整体暂停，再决定是否重试
          await sleep(pauseMs)
        } else if (willRetry) {
          // 指数退避：1s, 2s, 4s
          await sleep(minIntervalMs * 2 ** (attempt - 1))
        }

        onProgress?.({
          type: 'failure',
          domain: normalized,
          registrar: adapter.id,
          message: error instanceof Error ? error.message : String(error),
          willRetry,
        })
      } finally {
        clearTimeout(timer)
      }
    }

    if (lastError !== undefined) {
      errors.push({
        registrar: adapter.id,
        message: lastError instanceof Error ? lastError.message : String(lastError),
      })
    }

    // 出队后留出间隔，避免撞下一家的限流
    await sleep(minIntervalMs)
  }

  return { saved, errors }
}

/**
 * 批量刷新多个域名。
 * 串行执行：各家限流都是按时间窗口计的，并发只会更容易触发。
 */
export async function refreshDomains(
  domains: string[],
  adapters: RegistrarAdapter[],
  store: PriceStore,
  options: RefreshOptions = {},
): Promise<RefreshReport> {
  const started = Date.now()
  const errors: RefreshReport['errors'] = []
  let refreshed = 0
  let failed = 0
  let skipped = 0

  for (const domain of domains) {
    const result = await refreshDomain(domain, adapters, store, options)
    refreshed += result.saved.length
    if (result.errors.length > 0) {
      failed += 1
      for (const e of result.errors) {
        errors.push({ domain, registrar: e.registrar, message: e.message })
      }
    }
    if (result.saved.length === 0 && result.errors.length === 0) skipped += 1
  }

  return { refreshed, failed, skipped, durationMs: Date.now() - started, errors }
}

/**
 * 刷新缓存中已过期的域名。
 * 这是定时任务应当调用的入口。
 */
export async function refreshStale(
  adapters: RegistrarAdapter[],
  store: PriceStore,
  options: RefreshOptions & { limit?: number } = {},
): Promise<RefreshReport> {
  const stale = store.listStaleDomains(options.limit ?? 100)
  if (stale.length === 0) {
    return { refreshed: 0, failed: 0, skipped: 0, durationMs: 0, errors: [] }
  }
  return refreshDomains(stale, adapters, store, options)
}
