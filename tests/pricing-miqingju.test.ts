import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { listRoster, suggestedNext, IMPLEMENTED_SLUGS, __clearRosterCache } from '../src/lib/pricing/miqingju'

const realFetch = globalThis.fetch

/** 用假响应替换 fetch，避免测试依赖网络 */
function mockFetch(payload: unknown, status = 200) {
  globalThis.fetch = (async () => new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
  __clearRosterCache()
})

const sample = {
  success: true,
  data: {
    registrars: [
      { slug: 'small', name: 'Small Co', website: 'https://small.example', price_count: 5, last_updated: '2026-01-01 00:00:00' },
      { slug: 'big', name: 'Big Co', website: 'https://big.example', price_count: 900, last_updated: '2026-01-02 00:00:00' },
      { slug: 'mid', name: 'Mid Co', website: 'https://mid.example', price_count: 300, last_updated: '2026-01-03 00:00:00' },
    ],
    total_registrars: 3,
    total_tlds: 100,
    total_prices: 1205,
  },
}

describe('米情局名册 adapter', () => {
  test('解析名册并按覆盖度倒序排列', async () => {
    mockFetch(sample)
    const roster = await listRoster({ forceRefresh: true })
    assert.deepEqual(roster.registrars.map(r => r.slug), ['big', 'mid', 'small'])
    assert.equal(roster.registrars[0].priceCount, 900)
    assert.equal(roster.registrars[0].name, 'Big Co')
  })

  test('保留总计数用于展示', async () => {
    mockFetch(sample)
    const roster = await listRoster({ forceRefresh: true })
    assert.equal(roster.totalRegistrars, 3)
    assert.equal(roster.totalTlds, 100)
    assert.equal(roster.totalPrices, 1205)
  })

  test('过滤掉缺少 slug 或 name 的条目', async () => {
    mockFetch({ success: true, data: { registrars: [
      { slug: 'ok', name: 'OK', price_count: 10 },
      { slug: '', name: 'No Slug', price_count: 5 },
      { name: 'No Slug Key', price_count: 5 },
    ] } })
    const roster = await listRoster({ forceRefresh: true })
    assert.deepEqual(roster.registrars.map(r => r.slug), ['ok'])
  })

  test('price_count 缺失或非法时回落为 0', async () => {
    mockFetch({ success: true, data: { registrars: [
      { slug: 'a', name: 'A' },
      { slug: 'b', name: 'B', price_count: 'oops' },
    ] } })
    const roster = await listRoster({ forceRefresh: true })
    assert.ok(roster.registrars.every(r => r.priceCount === 0))
  })

  test('success 为 false 时报错，不静默返回空名册', async () => {
    mockFetch({ success: false, data: null })
    await assert.rejects(() => listRoster({ forceRefresh: true }), /结构异常/)
  })

  test('HTTP 错误时报错并带上状态码', async () => {
    mockFetch({}, 503)
    await assert.rejects(() => listRoster({ forceRefresh: true }), /HTTP 503/)
  })

  test('命中缓存时不重复请求', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response(JSON.stringify(sample), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    await listRoster()
    await listRoster()
    await listRoster()
    assert.equal(calls, 1, '24 小时内应命中缓存')

    await listRoster({ forceRefresh: true })
    assert.equal(calls, 2, 'forceRefresh 应绕过缓存')
  })

  test('超时会被中断而不是无限等待', async () => {
    globalThis.fetch = ((_url: any, init: any) => new Promise((_res, rej) => {
      // 永不返回，交由 AbortController 中断
      init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))
    })) as typeof fetch
    await assert.rejects(() => listRoster({ timeoutMs: 50, forceRefresh: true }))
  })

  test('请求头标明用途，便于对方识别流量', async () => {
    let ua = ''
    globalThis.fetch = ((_url: any, init: any) => {
      ua = init?.headers?.['User-Agent'] || ''
      return Promise.resolve(new Response(JSON.stringify(sample), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
    }) as typeof fetch
    await listRoster({ forceRefresh: true })
    assert.match(ua, /roster-only/)
  })

  test('suggestedNext 排除已接入的注册商', async () => {
    mockFetch({ success: true, data: {
      registrars: [
        { slug: 'cloudflare', name: 'Cloudflare', price_count: 950 },
        { slug: 'porkbun', name: 'Porkbun', price_count: 900 },
        { slug: 'godaddy', name: 'GoDaddy', price_count: 800 },
        { slug: 'namecheap', name: 'Namecheap', price_count: 700 },
      ],
    } })
    const next = await suggestedNext({ limit: 5, forceRefresh: true })
    const slugs = next.map(r => r.slug)
    assert.ok(!slugs.includes('cloudflare'))
    assert.ok(!slugs.includes('porkbun'))
    assert.deepEqual(slugs, ['godaddy', 'namecheap'])
  })

  test('suggestedNext 遵守 limit', async () => {
    mockFetch({ success: true, data: { registrars: Array.from({ length: 20 }, (_, i) => ({
      slug: `s${i}`, name: `N${i}`, price_count: 100 - i,
    })) } })
    const next = await suggestedNext({ limit: 3, forceRefresh: true })
    assert.equal(next.length, 3)
  })

  test('IMPLEMENTED_SLUGS 覆盖当前三家 adapter', () => {
    assert.deepEqual(Object.keys(IMPLEMENTED_SLUGS).sort(), ['cloudflare', 'porkbun', 'spaceship'])
  })
})
