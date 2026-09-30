/**
 * 文件：src/lib/pricing/miqingju.ts
 * 用途：米情局（miqingju.com）**开放端点**的注册商名册 adapter
 *
 * ## 这个 adapter 做什么、不做什么
 *
 * 只用它的**开放端点** `/api/v1/stats`：该端点无需任何验证即可访问，
 * 返回 128 家注册商的名册（名称、官网、slug、价格条数、最近采集时间）。
 *
 * **不使用 `/prices` 端点**。该端点有 Altcha PoW 工作量证明、一次性 token
 * 与 IP 级冷却三重访问控制，是明确的反自动化机制，绕过属规避访问控制。
 * 我们只把它当作「哪些注册商值得接官方 API」的线索来源。
 *
 * ## 为什么值得接
 *
 * 米情局维护了 128 家注册商、3367 个后缀的采集覆盖数据。
 * 这解决了「该接哪一家官方 API」的问题——按 price_count 排序，
 * 就知道哪家在多少后缀上有报价，而不必自己猜。
 *
 * ## 定位
 *
 * 本 adapter **不产出报价**，只产出注册商名册与覆盖度信息。
 * 因此它不参与 comparePrices() 的价格比较，而是作为接入优先级参考，
 * 通过 `listRoster()` 单独调用。
 *
 * 名册变化很慢（按天），故缓存 24 小时。
 */

/** 名册中的一家注册商 */
export interface RosterEntry {
  slug: string
  name: string
  website: string
  /** 该注册商有多少个后缀的报价被采集到，可粗略视为覆盖度 */
  priceCount: number
  lastUpdated: string
}

export interface Roster {
  registrars: RosterEntry[]
  totalRegistrars: number
  totalTlds: number
  totalPrices: number
  fetchedAt: number
}

const BASE_URL = 'https://api.miqingju.com/api/v1'
const ROSTER_TTL_MS = 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 15_000

/** 允许用环境变量覆盖，便于测试与自建镜像 */
function baseUrl(): string {
  return process.env.MIQINGJU_API_BASE?.replace(/\/$/, '') || BASE_URL
}

let cache: { roster: Roster; at: number } | null = null

interface StatsResponse {
  success?: boolean
  data?: {
    registrars?: {
      slug?: string
      name?: string
      website?: string
      price_count?: number
      last_updated?: string
    }[]
    total_registrars?: number
    total_tlds?: number
    total_prices?: number
  }
}

/**
 * 拉取注册商名册。
 *
 * 只调用开放端点 `/stats`。任何失败都抛错，由调用方决定是否降级，
 * 不让名册问题影响主流程。
 */
export async function listRoster(options: { timeoutMs?: number; forceRefresh?: boolean } = {}): Promise<Roster> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, forceRefresh = false } = options

  if (!forceRefresh && cache && Date.now() - cache.at < ROSTER_TTL_MS) {
    return cache.roster
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl()}/stats`, {
      headers: {
        // 标明来源，便于对方识别流量性质
        'User-Agent': 'whois-price-compare/1.0 (+roster-only; open endpoint)',
        Accept: 'application/json',
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`米情局名册请求失败：HTTP ${res.status}`)
    }

    const json = (await res.json()) as StatsResponse
    if (!json.success || !json.data) {
      throw new Error('米情局名册返回结构异常')
    }

    const registrars: RosterEntry[] = (json.data.registrars || [])
      .filter(r => r.slug && r.name)
      .map(r => ({
        slug: String(r.slug),
        name: String(r.name),
        website: String(r.website || ''),
        priceCount: Number(r.price_count) || 0,
        lastUpdated: String(r.last_updated || ''),
      }))
      // 覆盖度高的排前面，方便直接取前 N 家作为接入候选
      .sort((a, b) => b.priceCount - a.priceCount)

    const roster: Roster = {
      registrars,
      totalRegistrars: Number(json.data.total_registrars) || registrars.length,
      totalTlds: Number(json.data.total_tlds) || 0,
      totalPrices: Number(json.data.total_prices) || 0,
      fetchedAt: Date.now(),
    }

    cache = { roster, at: Date.now() }
    return roster
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 我们已接入的注册商在名册中的对应项。
 * 用于回答「已接入的这几家，在覆盖度上处于什么位置」。
 */
export const IMPLEMENTED_SLUGS: Record<string, string> = {
  cloudflare: 'cloudflare',
  porkbun: 'porkbun',
  spaceship: 'spaceship',
}

/**
 * 尚未接入、但覆盖度较高、值得优先考虑的注册商。
 *
 * 排除已接入者后按 priceCount 排序，取前 limit 家。
 */
export async function suggestedNext(
  options: { limit?: number; timeoutMs?: number; forceRefresh?: boolean } = {}
): Promise<RosterEntry[]> {
  const { limit = 10 } = options
  const roster = await listRoster(options)
  const done = new Set(Object.values(IMPLEMENTED_SLUGS))
  return roster.registrars.filter(r => !done.has(r.slug)).slice(0, limit)
}

/** 仅供测试：清空缓存 */
export function __clearRosterCache() {
  cache = null
}
