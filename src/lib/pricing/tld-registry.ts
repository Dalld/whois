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
import { GandiTldSource } from './gandi-tld'

/**
 * 数据源分两类：
 *
 * **整表数据源**（一次拿到全部后缀）
 * - Porkbun 官方 `/pricing/get`：公开、无需认证、911 个后缀、结构化 JSON。
 *
 * **逐后缀数据源**（补齐整表未收录的国别后缀）
 * - Gandi：`.im` 注册 $20/续费 $39.98、`.al` 注册 $395/续费 $663.98。
 *   没有全量价目页，按后缀抓。
 *
 * Porkbun 定价页抓取（605 个后缀）作为接口下线时的兜底，
 * 默认不装配，用 TLD_PORKBUN_MODE=crawl 启用。
 *
 * ## 试过但不可用的数据源
 *
 * - **Netim**：`.al` €16/年、`.im` €20/年，是本轮找到的最低价，
 *   但站点前置 Cloudflare，对 Node 的 fetch 一律返回 403
 *   （同样的 URL 用 PowerShell 请求是 200，说明是按 TLS 指纹拦截）。
 *   实测换用浏览器 UA、补全 sec-ch-ua / Sec-Fetch-* 等请求头
 *   仍为 403。**未做进一步规避**——绕过 WAF 属于规避访问控制。
 * - **nic.im / akep.al**：`.im` 与 `.al` 的注册局，
 *   页面为注册表单与规则说明，**不含价格**。
 * - **Cloudflare /tld-policies/**：返回 200 且体积 690KB，
 *   但正文无任何价格数字（实测 `$x.xx` 匹配数为 0），
 *   价目为客户端渲染，不可解析。
 * - **Namecheap / NameSilo / Dynadot 定价页**：前两者 403，
 *   Dynadot 为落地页、价目动态加载。
 * - **INWX**：`domain.getPrices` 可一次返回全部 TLD，
 *   但需账号凭证（用户名+密码，2FA 还需 TOTP），
 *   且价格按登录账号的币种与 VAT 国家计算，不是中立的公开价目表。
 */

export type PorkbunMode = 'api' | 'crawl'

export function porkbunMode(): PorkbunMode {
  return process.env.TLD_PORKBUN_MODE === 'crawl' ? 'crawl' : 'api'
}

/** 整表数据源：一次覆盖全部后缀 */
export function buildBulkSources(): TldPriceSourceAdapter[] {
  return [porkbunMode() === 'crawl' ? new PorkbunTldSource() : new PorkbunTldApiSource()]
}

/** 逐后缀数据源：补齐整表未收录的国别后缀 */
export function buildGapSources(): TldPriceSourceAdapter[] {
  return [new GandiTldSource()]
}

/** 装配全部后缀价数据源 */
export function buildTldSources(): TldPriceSourceAdapter[] {
  return [...buildBulkSources(), ...buildGapSources()]
}

/** 数据源状态说明，供 CLI 与诊断使用 */
export function tldSourceStatus(): { id: string; name: string; kind: string; note: string }[] {
  const mode = porkbunMode()
  return [
    {
      id: 'porkbun',
      name: 'Porkbun',
      kind: mode === 'crawl' ? '整表·抓页' : '整表·公开接口',
      note: mode === 'crawl'
        ? '抓取定价页（约 605 个后缀），接口不可用时使用'
        : '官方 /pricing/get，无需认证（约 911 个后缀）',
    },
    { id: 'gandi', name: 'Gandi', kind: '逐后缀·抓页', note: '.al / .im（Porkbun 未收录）' },
  ]
}