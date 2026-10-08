/**
 * 文件：src/lib/pricing/tld-types.ts
 * 用途：后缀级比价 —— 数据模型
 *
 * ## 与域名级比价的区别
 *
 * 域名级（`types.ts`）问的是「这个具体域名在 A 家多少钱、在 B 家多少钱」，
 * 需要逐域名调用注册商 API，受批量上限与限流约束。
 *
 * 后缀级（本文件）问的是「`.cx` 这个后缀，各家挂牌价多少」。
 * 这是**静态的价目表**，一次抓取即可覆盖几百个后缀，
 * 且能覆盖没有公开 API 的小众国别后缀。
 *
 * ## 为什么不看溢价
 *
 * 后缀价是**非溢价域名的挂牌价**。具体某个域名是否溢价、是否已被注册，
 * 由用户在注册商页面上自行确认。后缀级比价只回答
 * 「这个后缀大致什么价位、哪家最便宜」，不承诺最终结算价。
 */

/** 一家注册商对某个后缀的报价 */
export interface TldPrice {
  /** TLD，不含前导点，小写，如 "cx" 或 "co.uk" */
  tld: string
  /** 注册商标识，如 "porkbun" */
  registrar: string
  /** 注册商显示名 */
  registrarName: string
  /** 注册价（首年，已含促销） */
  register: number | null
  /** 续费价 */
  renew: number | null
  /** 转移价 */
  transfer: number | null
  /** 促销前的标准注册价；无促销时与 register 相同 */
  regularRegister: number | null
  /** 是否处于首年促销 */
  onSale: boolean
  /** 币种 */
  currency: 'USD'
  /** 数据来源标识 */
  source: TldPriceSource
  /** 注册商官网，用于「去注册」链接 */
  website: string
  /** 数据获取时间（ISO 8601） */
  fetchedAt: string
}

/**
 * live   —— 从注册商官方来源实时抓取/调用
 * cached —— 来自本地缓存
 */
export type TldPriceSource = 'live' | 'api' | 'crawled'

/** 后缀比价数据源接口 */
export interface TldPriceSourceAdapter {
  /** 数据源标识，如 "porkbun" */
  readonly id: string
  /** 显示名 */
  readonly name: string
  /** 官网 */
  readonly website: string
  /**
   * 拉取该数据源的**全部**后缀价格。
   * 首次调用后应由上层缓存，不宜频繁调用。
   */
  fetchAll(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<TldPrice[]>
}

/** 一次后缀比价的结果 */
export interface TldComparison {
  /** 查询的后缀（不含点） */
  tld: string
  /** 各注册商报价，按续费价升序 */
  quotes: TldPrice[]
  /** 续费价最低者 */
  cheapest: TldPrice | null
  /** 未收录该后缀的数据源 */
  missing: string[]
  /** 抓取失败的数据源 */
  errors: { source: string; message: string }[]
  /** 数据时间 */
  fetchedAt: string
}

/** 规范化 TLD：去掉前导点、转小写 */
export function normalizeTld(input: string): string {
  return input.toLowerCase().replace(/^\.+/, '').trim()
}

/**
 * 从域名中解析出候选 TLD，**最长优先**，供在价目表中查找。
 *
 * 例：`a.b.co.uk` → `['b.co.uk', 'co.uk', 'uk']`
 *
 * 之所以返回多个候选：我们无法凭空判断 `co.uk` 是「两段式后缀」
 * 还是「SLD + 后缀」，所以由调用方按顺序在价目表里试，
 * 命中第一个即为该域名实际使用的后缀。
 *
 * 注意末段始终是候选之一：`feng.cx` → `['cx']`（`feng.cx` 不是后缀，
 * 不应作为候选，否则会把 SLD 误当后缀去查价）。
 */
export function tldCandidates(domain: string): string[] {
  const parts = domain.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean)
  // 至少要有「名字 + 后缀」两段；单段无后缀可言
  if (parts.length <= 1) return []
  const suffixParts = parts.slice(1) // 去掉 SLD 部分
  const out: string[] = []
  // 最长优先：最多取三段后缀（如 a.b.c.d → c.d 与 d 等）
  for (let n = Math.min(3, suffixParts.length); n >= 1; n--) {
    out.push(suffixParts.slice(-n).join('.'))
  }
  return out
}

/**
 * 按续费价排序；续费价缺失时回落注册价，皆无则排最后。
 *
 * 用续费价而非首年价：首年价常被用来引流（$0.99 首年 / $29 续费），
 * 按首年价排会得出误导性的「最便宜」。
 */
export function sortKey(p: TldPrice): number {
  if (typeof p.renew === 'number' && p.renew > 0) return p.renew
  if (typeof p.register === 'number' && p.register > 0) return p.register
  return Number.POSITIVE_INFINITY
}
