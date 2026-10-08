/**
 * 文件：src/lib/pricing/tld-registry.ts
 * 用途：后缀价数据源的装配
 *
 * 与域名级注册表（registry.ts）不同，后缀级数据源**不需要凭证**：
 * 它们要么是公开接口，要么是可抓取的定价页。因此这里不按环境变量筛选，
 * 而是全部装配。
 *
 * 同一注册商可能有多种取数方式（接口 / 抓页），这里只装配优先级最高的
 * 一种，避免同一注册商在比价结果里出现两次。
 */

import type { TldPriceSourceAdapter } from './tld-types'
import { PorkbunTldApiSource } from './porkbun-tld-api'
import { PorkbunTldSource } from './porkbun-tld'

/**
 * 数据源优先级说明：
 *
 * - Porkbun 官方 `/pricing/get`：公开、无需认证、911 个后缀、结构化 JSON。
 *   是首选。
 * - Porkbun 定价页抓取：605 个后缀，正则解析，作为接口下线时的兜底。
 *   默认**不装配**，用 TLD_PORKBUN_MODE=crawl 启用。
 */

export type PorkbunMode = 'api' | 'crawl'

export function porkbunMode(): PorkbunMode {
  return process.env.TLD_PORKBUN_MODE === 'crawl' ? 'crawl' : 'api'
}

/** 装配全部后缀价数据源 */
export function buildTldSources(): TldPriceSourceAdapter[] {
  const sources: TldPriceSourceAdapter[] = []

  sources.push(porkbunMode() === 'crawl' ? new PorkbunTldSource() : new PorkbunTldApiSource())

  return sources
}

/** 数据源状态说明，供 CLI 与诊断使用 */
export function tldSourceStatus(): { id: string; name: string; note: string; kind: string }[] {
  const mode = porkbunMode()
  return [
    {
      id: 'porkbun',
      name: 'Porkbun',
      kind: mode === 'crawl' ? '定价页抓取' : '官方公开接口',
      note: mode === 'crawl'
        ? '抓取定价页（约 605 个后缀），接口不可用时使用'
        : '官方 /pricing/get，无需认证（约 911 个后缀）',
    },
  ]
}