/**
 * 文件：tests/net-guard.test.ts
 * 用途：出站地址校验（SSRF 防护）与限流的回归测试
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertSafeOutboundUrl, isSafeOutboundUrl, isBlockedHost } from '../src/lib/net-guard'
import { RateLimiter, clientKey } from '../src/lib/rate-limit'

test('allows ordinary public https endpoints', () => {
  assert.ok(isSafeOutboundUrl('https://rdap.verisign.com/com/v1'))
  assert.ok(isSafeOutboundUrl('https://data.iana.org/rdap/dns.json'))
  assert.ok(isSafeOutboundUrl('https://rdap.org/domain/example.com'))
  assert.ok(isSafeOutboundUrl('https://8.8.8.8/rdap'))
})

test('rejects non-https protocols', () => {
  assert.throws(() => assertSafeOutboundUrl('http://rdap.verisign.com/com/v1'))
  assert.throws(() => assertSafeOutboundUrl('file:///etc/passwd'))
  assert.throws(() => assertSafeOutboundUrl('ftp://example.com/x'))
  assert.throws(() => assertSafeOutboundUrl('gopher://example.com/'))
})

test('rejects cloud metadata and loopback addresses', () => {
  // 云主机元数据服务，SSRF 的典型目标
  assert.throws(() => assertSafeOutboundUrl('https://169.254.169.254/latest/meta-data/'))
  assert.throws(() => assertSafeOutboundUrl('https://127.0.0.1/rdap'))
  assert.throws(() => assertSafeOutboundUrl('https://localhost/rdap'))
  assert.throws(() => assertSafeOutboundUrl('https://[::1]/rdap'))
  assert.throws(() => assertSafeOutboundUrl('https://[::ffff:127.0.0.1]/rdap'))
  assert.ok(isBlockedHost('169.254.169.254'))
  assert.ok(isBlockedHost('localhost'))
})

test('rejects private and reserved IPv4 ranges', () => {
  for (const host of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '0.0.0.0', '224.0.0.1', '198.51.100.5']) {
    assert.ok(isBlockedHost(host), `${host} 应被拦截`)
  }
  // 172.32.x 不在私网范围内，应放行
  assert.equal(isBlockedHost('172.32.0.1'), false)
  assert.equal(isBlockedHost('8.8.4.4'), false)
})

test('rejects internal-looking hostnames and credentials', () => {
  assert.throws(() => assertSafeOutboundUrl('https://service.local/rdap'))
  assert.throws(() => assertSafeOutboundUrl('https://db.internal/rdap'))
  assert.throws(() => assertSafeOutboundUrl('https://user:pass@rdap.verisign.com/com/v1'))
})

test('enforces the optional host allowlist', () => {
  const allowed = ['rdap.verisign.com', 'rdap.arin.net']
  assert.ok(isSafeOutboundUrl('https://rdap.verisign.com/com/v1', allowed))
  assert.equal(isSafeOutboundUrl('https://evil.example.com/rdap', allowed), false)
})

test('rate limiter allows up to the limit then blocks with retry hint', () => {
  const limiter = new RateLimiter({ windowMs: 1000, max: 3 })
  const t0 = 1_000_000
  assert.equal(limiter.check('a', t0).ok, true)
  assert.equal(limiter.check('a', t0 + 10).ok, true)
  assert.equal(limiter.check('a', t0 + 20).ok, true)
  const blocked = limiter.check('a', t0 + 30)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.remaining, 0)
  assert.ok(blocked.retryAfter >= 1)
})

test('rate limiter isolates keys and expires the window', () => {
  const limiter = new RateLimiter({ windowMs: 1000, max: 2 })
  const t0 = 5_000_000
  assert.equal(limiter.check('a', t0).ok, true)
  assert.equal(limiter.check('a', t0).ok, true)
  assert.equal(limiter.check('a', t0).ok, false)
  // 另一个来源不受影响
  assert.equal(limiter.check('b', t0).ok, true)
  // 窗口滑过后恢复
  assert.equal(limiter.check('a', t0 + 1001).ok, true)
})

test('rate limiter bounds memory by maxKeys', () => {
  const limiter = new RateLimiter({ windowMs: 60_000, max: 5, maxKeys: 10 })
  for (let i = 0; i < 10; i++) limiter.check(`k${i}`, 1_000)
  // 达到上限后新来源被拒绝，而不是无限增长
  const overflow = limiter.check('overflow', 1_000)
  assert.equal(overflow.ok, false)
  assert.ok(limiter.size <= 10)
})

test('clientKey prefers the first forwarded address', () => {
  const make = (headers: Record<string, string>) => new Request('https://example.com', { headers })
  assert.equal(clientKey(make({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })), '203.0.113.7')
  assert.equal(clientKey(make({ 'x-real-ip': '198.51.100.9' })), '198.51.100.9')
  assert.equal(clientKey(make({ 'cf-connecting-ip': '203.0.113.20' })), '203.0.113.20')
  assert.equal(clientKey(make({})), 'unknown')
})
