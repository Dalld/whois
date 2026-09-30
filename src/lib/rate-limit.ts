/**
 * 文件：src/lib/rate-limit.ts
 * 用途：API 访问限流（进程内滑动窗口）
 *
 * 为什么需要：/api/whois 是公开、无鉴权、且每次请求都会真实外连
 * IANA 与各国注册局的接口。若不限流，任何人都能把本站当作免费代理
 * 去打上游，导致出口 IP 被注册局封禁（.es 等后缀还要求预先报备出口 IP）。
 *
 * 说明：本实现为单进程内存版，适用于单实例部署。
 * 多实例部署时各实例独立计数，应替换为 Redis 等共享存储。
 */

interface Window {
  /** 窗口内的时间戳（毫秒），按到达顺序排列 */
  hits: number[]
  /** 上次访问时间，用于惰性清理 */
  seen: number
}

export interface RateLimitOptions {
  /** 时间窗口长度（毫秒） */
  windowMs?: number
  /** 窗口内允许的最大请求数 */
  max?: number
  /** 最多跟踪多少个来源，防止内存无限增长 */
  maxKeys?: number
}

export interface RateLimitResult {
  ok: boolean
  /** 剩余可用次数 */
  remaining: number
  /** 建议的重试等待秒数 */
  retryAfter: number
  /** 窗口上限，用于响应头 */
  limit: number
}

const DEFAULT_WINDOW_MS = 60 * 1000
const DEFAULT_MAX = 30
const DEFAULT_MAX_KEYS = 10_000

/**
 * 读取正整数环境变量，非法或未设置时回退默认值。
 * WHOIS_RATE_LIMIT / WHOIS_RATE_WINDOW_MS 可用于按部署规模调整，
 * 测试环境通过设为 0 关闭限流（见测试夹具）。
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

/** 惰性清理：避免长期运行后 Map 无界增长 */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000

export class RateLimiter {
  private windows = new Map<string, Window>()
  private lastSweep = 0
  private readonly windowMs: number
  private readonly max: number
  private readonly maxKeys: number

  constructor(options: RateLimitOptions = {}) {
    // 显式传入的选项优先；未传入时在 check() 时惰性读取环境变量，
    // 这样测试文件可以在模块导入后设置 WHOIS_RATE_LIMIT=0。
    this.windowMs = options.windowMs ?? 0
    this.max = options.max ?? -1
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS
  }

  /** 是否启用（max 为 0 时关闭，供自动化测试使用） */
  get enabled(): boolean {
    return this.limit > 0
  }

  /** 生效的窗口长度：显式配置优先，否则读环境变量或默认值 */
  private get window(): number {
    return this.windowMs || envInt('WHOIS_RATE_WINDOW_MS', DEFAULT_WINDOW_MS)
  }

  /** 生效的上限：显式配置优先，否则读环境变量或默认值 */
  private get limit(): number {
    return this.max >= 0 ? this.max : envInt('WHOIS_RATE_LIMIT', DEFAULT_MAX)
  }

  /** 记录一次访问并返回判定结果 */
  check(key: string, now = Date.now()): RateLimitResult {
    const max = this.limit
    const windowMs = this.window
    if (max <= 0) return { ok: true, remaining: Infinity, retryAfter: 0, limit: 0 }
    this.sweep(now)

    let entry = this.windows.get(key)
    if (!entry) {
      // 达到容量上限时，先清理过期项，仍满则拒绝新来源以保护内存
      if (this.windows.size >= this.maxKeys) {
        this.sweep(now, true)
        if (this.windows.size >= this.maxKeys) {
          return { ok: false, remaining: 0, retryAfter: Math.ceil(windowMs / 1000), limit: max }
        }
      }
      entry = { hits: [], seen: now }
      this.windows.set(key, entry)
    }

    entry.seen = now
    const cutoff = now - windowMs
    // 丢弃窗口外的记录
    if (entry.hits.length && entry.hits[0] <= cutoff) {
      entry.hits = entry.hits.filter(t => t > cutoff)
    }

    if (entry.hits.length >= max) {
      const oldest = entry.hits[0]
      const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
      return { ok: false, remaining: 0, retryAfter, limit: max }
    }

    entry.hits.push(now)
    return { ok: true, remaining: max - entry.hits.length, retryAfter: 0, limit: max }
  }

  /** 清空全部计数（测试用） */
  reset(): void {
    this.windows.clear()
    this.lastSweep = 0
  }

  get size(): number {
    return this.windows.size
  }

  /** 删除长期未访问的条目；force 时忽略最小间隔 */
  private sweep(now: number, force = false): void {
    if (!force && now - this.lastSweep < SWEEP_INTERVAL_MS) return
    this.lastSweep = now
    const expireBefore = now - this.windowMs
    for (const [key, entry] of this.windows) {
      const last = entry.hits.length ? entry.hits[entry.hits.length - 1] : entry.seen
      if (last <= expireBefore) this.windows.delete(key)
    }
  }
}

/**
 * 从请求头解析客户端标识。
 * 反向代理部署时以 X-Forwarded-For 的第一段为准，否则回退到直连地址。
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return request.headers.get('x-real-ip')?.trim()
    || request.headers.get('cf-connecting-ip')?.trim()
    || 'unknown'
}

/** 单例：整个进程共用一份计数 */
export const apiRateLimiter = new RateLimiter()
