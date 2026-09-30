/**
 * 文件：src/lib/pricing/types.ts
 * 用途：域名比价 —— 统一报价模型
 *
 * 各家注册商返回的字段名、币种、价格语义都不相同，这里定义一层归一化结构，
 * 所有 adapter 的输出都必须满足该结构，上层无需关心数据来源。
 *
 * 设计要点：
 * - 首年价与续费价分开存储。只展示首年价会误导用户，
 *   许多注册商以极低首年价引流、续费价却很高。
 * - premium 单列。同一后缀下，溢价域名价格可达普通域名的百倍，
 *   不区分则比价结果没有意义。
 * - 价格统一为数值型（USD），同时保留原始字符串与币种以便追溯。
 */

/** 价格类型：注册 / 续费 / 转移 */
export type PriceKind = 'register' | 'renew' | 'transfer'

/** 单个价格项 */
export interface PriceQuote {
  /** 实际成交价（可能是促销价） */
  price: number
  /** 标准价（无促销时与 price 相同） */
  regularPrice: number
  /** 是否为促销价 */
  onSale: boolean
}

/** 某一注册商对某个域名的完整报价 */
export interface RegistrarQuote {
  /** 注册商标识，如 "porkbun" */
  registrar: string
  /** 注册商显示名，如 "Porkbun" */
  registrarName: string
  /** 查询的域名（小写） */
  domain: string
  /** 顶级域，如 "com" */
  tld: string
  /** 是否可注册 */
  available: boolean
  /** 是否为溢价域名 */
  premium: boolean
  /** 币种，统一为 USD */
  currency: 'USD'
  /** 注册价（首年） */
  register: PriceQuote | null
  /** 续费价 */
  renew: PriceQuote | null
  /** 转移价 */
  transfer: PriceQuote | null
  /** 注册局要求的最短注册年限 */
  minDuration: number | null
  /** 数据获取时间（ISO 8601） */
  fetchedAt: string
  /** 数据来源标识：live / sandbox / mock */
  source: QuoteSource
  /** 原始响应，便于排查。仅在调试时使用 */
  raw?: unknown
}

export type QuoteSource = 'live' | 'sandbox' | 'mock'

/** 一次比价查询的聚合结果 */
export interface PriceComparison {
  domain: string
  tld: string
  /** 各注册商报价，按续费价升序（续费价缺失的排在最后） */
  quotes: RegistrarQuote[]
  /** 报价最低的注册商（按续费价，续费价缺失时回落首年价） */
  cheapest: RegistrarQuote | null
  /** 查询失败的注册商及原因 */
  errors: { registrar: string; message: string }[]
  /** 本次查询时间 */
  queriedAt: string
}

/** adapter 的公共接口 */
export interface RegistrarAdapter {
  /** 注册商标识 */
  readonly id: string
  /** 注册商显示名 */
  readonly name: string
  /**
   * 查询单个域名的报价。
   * 失败时应抛出错误，由上层捕获并汇总到 errors。
   */
  fetchQuote(domain: string, options?: { signal?: AbortSignal }): Promise<RegistrarQuote>
  /**
   * 批量查询。默认由单查询循环实现；
   * 若注册商支持批量接口，adapter 应覆写以提升效率。
   */
  fetchQuotes?(domains: string[], options?: { signal?: AbortSignal }): Promise<RegistrarQuote[]>
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

/** 从域名中取出 TLD（支持多段后缀如 co.uk） */
export function extractTld(domain: string): string {
  const parts = domain.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean)
  if (parts.length <= 1) return ''
  // 常见两段式公共后缀
  const twoLevel = new Set([
    'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk',
    'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
    'com.au', 'net.au', 'org.au', 'co.jp', 'co.kr',
    'com.br', 'com.tw', 'com.hk', 'com.sg', 'co.nz', 'co.za',
  ])
  const lastTwo = parts.slice(-2).join('.')
  if (twoLevel.has(lastTwo)) return lastTwo
  return parts[parts.length - 1]
}

/**
 * 把注册商返回的价格字符串转成数值。
 * 各家格式不一（"9.73"、"$9.73"、"9,73"），统一在此处理。
 * 无法解析时返回 null，而不是 0 —— 0 会被误认为免费。
 */
export function parsePrice(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[^\d.,-]/g, '').replace(/,/g, '')
  if (!cleaned) return null
  const n = Number.parseFloat(cleaned)
  return Number.isFinite(n) ? n : null
}

/** 解析 "yes" / "no" 形式的布尔值 */
export function parseYesNo(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'yes'
}

/**
 * 由「实际价」与「标准价」构造价格项。
 * 两者相差超过 0.01 视为促销。
 */
export function makeQuote(
  price: unknown,
  regularPrice: unknown,
  explicitPromo?: boolean,
): PriceQuote | null {
  const actual = parsePrice(price)
  const regular = parsePrice(regularPrice)
  if (actual === null && regular === null) return null
  const finalActual = actual ?? regular!
  const finalRegular = regular ?? actual!
  const diff = Math.abs(finalRegular - finalActual) > 0.01
  return {
    price: finalActual,
    regularPrice: finalRegular,
    onSale: explicitPromo ?? diff,
  }
}
