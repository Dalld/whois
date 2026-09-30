/**
 * 文件：src/lib/net-guard.ts
 * 用途：统一出站请求的地址校验（SSRF 防护）
 *
 * 背景：本项目会从外部数据源获取待请求的 URL——
 * - IANA RDAP bootstrap（data.iana.org）返回的注册局地址
 * - 上游 RDAP 响应体中 links[].href 指向的注册商 RDAP 地址
 * - RDAP 转介的 Location 响应头
 *
 * 这些都是「外部可控数据」，若不校验，攻击者可通过污染上游响应让服务端
 * 请求内网地址（如云主机元数据 169.254.169.254），造成凭证泄露。
 *
 * 因此所有出站请求都必须先经过 assertSafeOutboundUrl()。
 */

/** 仅允许 https：源站均为 https，排除 http/文件协议等 */
const ALLOWED_PROTOCOLS = new Set(['https:'])

/** IPv4 私网、环回、链路本地、保留段 */
function isBlockedIPv4(parts: number[]): boolean {
  const [a, b] = parts
  if (a === 0) return true // 0.0.0.0/8 本网络
  if (a === 10) return true // 10.0.0.0/8 私网
  if (a === 127) return true // 环回
  if (a === 169 && b === 254) return true // 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 私网
  if (a === 192 && b === 168) return true // 192.168.0.0/16 私网
  if (a === 192 && b === 0) return true // 192.0.0.0/24 保留 / 192.0.2.0/24 文档
  if (a === 198 && (b === 18 || b === 19)) return true // 基准测试段
  if (a === 198 && b === 51) return true // 198.51.100.0/24 文档
  if (a === 203 && b === 0) return true // 203.0.113.0/24 文档
  if (a >= 224) return true // 组播与保留
  return false
}

/** 判断主机名是否为 IP 字面量，并拦截内网地址 */
function assertHostnameAllowed(hostname: string): void {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')

  // IPv4 字面量
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const parts = v4.slice(1, 5).map(Number)
    if (parts.some(n => n > 255)) throw new Error('出站地址非法：IPv4 越界')
    if (isBlockedIPv4(parts)) throw new Error('出站地址被拒绝：指向内网或保留地址')
    return
  }

  // IPv6 字面量
  if (host.includes(':')) {
    if (host === '::' || host === '::1') throw new Error('出站地址被拒绝：IPv6 环回')
    // 唯一本地地址 fc00::/7、链路本地 fe80::/10、IPv4 映射 ::ffff:
    if (/^f[cd]/.test(host)) throw new Error('出站地址被拒绝：IPv6 唯一本地地址')
    if (/^fe[89ab]/.test(host)) throw new Error('出站地址被拒绝：IPv6 链路本地地址')
    if (/^::ffff:/.test(host)) throw new Error('出站地址被拒绝：IPv4 映射地址')
    if (/^ff/.test(host)) throw new Error('出站地址被拒绝：IPv6 组播地址')
    return
  }

  // 主机名黑名单
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('出站地址被拒绝：localhost')
  if (host.endsWith('.local') || host.endsWith('.internal')) throw new Error('出站地址被拒绝：内部域名')
}

/**
 * 校验并返回安全的出站 URL；不合法时抛出异常。
 * @param raw 待校验的 URL 字符串
 * @param allowedHosts 可选主机白名单；提供时主机必须精确命中
 */
export function assertSafeOutboundUrl(raw: string, allowedHosts?: readonly string[]): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('出站地址非法：无法解析的 URL')
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`出站地址被拒绝：仅允许 https，收到 ${url.protocol}`)
  }
  // 带凭证的 URL 可能被用于绕过解析或泄露，直接拒绝
  if (url.username || url.password) {
    throw new Error('出站地址被拒绝：不允许包含认证信息')
  }

  assertHostnameAllowed(url.hostname)

  if (allowedHosts && !allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new Error(`出站地址被拒绝：${url.hostname} 不在允许列表中`)
  }

  return url
}

/** 纯判断版本，用于过滤而非抛错 */
export function isSafeOutboundUrl(raw: string, allowedHosts?: readonly string[]): boolean {
  try {
    assertSafeOutboundUrl(raw, allowedHosts)
    return true
  } catch {
    return false
  }
}

/** 供测试与诊断使用的内网判断 */
export function isBlockedHost(hostname: string): boolean {
  try {
    assertHostnameAllowed(hostname)
    return false
  } catch {
    return true
  }
}
