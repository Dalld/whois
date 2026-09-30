import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PriceStore } from '../src/lib/pricing/store'
import { parseRetryAfter, refreshDomain, refreshDomains, refreshStale } from '../src/lib/pricing/refresh'
import type { RegistrarAdapter, RegistrarQuote } from '../src/lib/pricing/types'

function quote(over: Partial<RegistrarQuote> = {}): RegistrarQuote {
  return {
    registrar: 'porkbun', registrarName: 'Porkbun', domain: 'example.com', tld: 'com',
    available: true, premium: false, currency: 'USD',
    register: { price: 9.73, regularPrice: 9.73, onSale: false },
    renew: { price: 11.06, regularPrice: 11.06, onSale: false },
    transfer: { price: 9.73, regularPrice: 9.73, onSale: false },
    minDuration: 1, fetchedAt: new Date().toISOString(), source: 'live',
    ...over,
  }
}

/** 记录调用次数的 stub adapter */
function countingAdapter(
  id: string,
  behavior: RegistrarQuote | Error | (() => RegistrarQuote | Error),
): RegistrarAdapter & { calls: number } {
  const a = {
    id, name: id, calls: 0,
    async fetchQuote() {
      a.calls += 1
      const v = typeof behavior === 'function' ? behavior() : behavior
      if (v instanceof Error) throw v
      return v
    },
  }
  return a
}

/** 不真正等待的 sleep，同时记录请求间隔 */
function recordingSleep() {
  const waits: number[] = []
  return { waits, sleep: async (ms: number) => { waits.push(ms) } }
}

/* ------------------------------------------------------------------ */
/* 存储层                                                              */
/* ------------------------------------------------------------------ */

test('PriceStore 保存并读回完整报价', () => {
  const store = new PriceStore({ path: ':memory:' })
  try {
    store.save(quote())
    const got = store.get('porkbun', 'example.com')
    assert.ok(got)
    assert.equal(got.quote.register?.price, 9.73)
    assert.equal(got.quote.renew?.price, 11.06)
    assert.equal(got.quote.transfer?.price, 9.73)
    assert.equal(got.quote.premium, false)
    assert.equal(got.quote.source, 'live')
    assert.equal(got.expired, false)
    assert.ok(got.expiresAt > got.storedAt)
  } finally { store.close() }
})

test('PriceStore 域名查询不区分大小写', () => {
  const store = new PriceStore({ path: ':memory:' })
  try {
    store.save(quote({ domain: 'example.com' }))
    assert.ok(store.get('porkbun', 'EXAMPLE.COM'))
    assert.ok(store.get('porkbun', 'Example.Com'))
  } finally { store.close() }
})

test('PriceStore 覆盖写会更新价格并记录历史', () => {
  const store = new PriceStore({ path: ':memory:' })
  try {
    store.save(quote({ renew: { price: 11.06, regularPrice: 11.06, onSale: false } }))
    store.save(quote({ renew: { price: 12.5, regularPrice: 12.5, onSale: false } }))

    const got = store.get('porkbun', 'example.com')
    assert.equal(got?.quote.renew?.price, 12.5, '应保存最新价格')
    assert.equal(store.stats().quotes, 1, '同一 (注册商,域名) 只应有一行')
    assert.equal(store.stats().history, 2, '价格变动应记录两条历史')
  } finally { store.close() }
})

test('PriceStore 价格未变时不重复写历史', () => {
  const store = new PriceStore({ path: ':memory:' })
  try {
    store.save(quote())
    store.save(quote())
    store.save(quote())
    assert.equal(store.stats().history, 1, '价格相同不应累积历史行')
  } finally { store.close() }
})

test('PriceStore 过期后默认不返回，可显式读取陈旧数据', () => {
  const store = new PriceStore({ path: ':memory:', ttlMs: 0 })
  try {
    store.save(quote())
    // ttlMs=0 表示立即过期
    assert.equal(store.get('porkbun', 'example.com'), null, '默认应过滤过期数据')

    const stale = store.get('porkbun', 'example.com', true)
    assert.ok(stale, 'includeExpired=true 时应返回')
    assert.equal(stale.expired, true)
  } finally { store.close() }
})

test('PriceStore 按域名取多家报价并保持续费价升序', () => {
  const store = new PriceStore({ path: ':memory:' })
  try {
    store.save(quote({ registrar: 'expensive', renew: { price: 30, regularPrice: 30, onSale: false } }))
    store.save(quote({ registrar: 'cheap', renew: { price: 8, regularPrice: 8, onSale: false } }))
    store.save(quote({ registrar: 'mid', renew: { price: 15, regularPrice: 15, onSale: false } }))

    const all = store.getByDomain('example.com')
    assert.deepEqual(all.map(s => s.quote.registrar), ['cheap', 'mid', 'expensive'])
  } finally { store.close() }
})

test('PriceStore 列出过期域名供刷新使用', () => {
  const store = new PriceStore({ path: ':memory:', ttlMs: 0 })
  try {
    store.save(quote({ domain: 'a.com' }))
    store.save(quote({ domain: 'b.com' }))
    const stale = store.listStaleDomains()
    assert.equal(stale.length, 2)
    assert.ok(stale.includes('a.com') && stale.includes('b.com'))
  } finally { store.close() }
})

test('PriceStore 保存 null 价格不报错', () => {
  const store = new PriceStore({ path: ':memory:' })
  try {
    store.save(quote({ register: null, renew: null, transfer: null, minDuration: null }))
    const got = store.get('porkbun', 'example.com')
    assert.ok(got)
    assert.equal(got.quote.register, null)
    assert.equal(got.quote.renew, null)
    assert.equal(got.quote.minDuration, null)
  } finally { store.close() }
})

test('PriceStore saveMany 批量写入后统计正确', () => {
  const store = new PriceStore({ path: ':memory:' })
  try {
    store.saveMany([
      quote({ registrar: 'a' }),
      quote({ registrar: 'b' }),
      quote({ registrar: 'c' }),
    ])
    const s = store.stats()
    assert.equal(s.quotes, 3)
    assert.equal(s.registrars, 3)
    assert.equal(s.domains, 1)
  } finally { store.close() }
})

/* ------------------------------------------------------------------ */
/* 刷新调度                                                            */
/* ------------------------------------------------------------------ */

test('parseRetryAfter 解析 Retry-After 并回落默认值', () => {
  assert.equal(parseRetryAfter(new Error('HTTP 429; Retry-After: 30'), 5000), 30_000)
  assert.equal(parseRetryAfter(new Error('429 retry-after: 5'), 5000), 5000)
  assert.equal(parseRetryAfter(new Error('Retry-After: 7'), 5000), 7000)
  assert.equal(parseRetryAfter(new Error('普通错误'), 5000), 5000)
  assert.equal(parseRetryAfter('字符串错误', 1234), 1234)
})

test('refreshDomain 成功时写入缓存', async () => {
  const store = new PriceStore({ path: ':memory:' })
  try {
    const adapter = countingAdapter('porkbun', quote())
    const { sleep } = recordingSleep()
    const result = await refreshDomain('example.com', [adapter], store, { sleep })

    assert.equal(result.saved.length, 1)
    assert.equal(result.errors.length, 0)
    assert.equal(adapter.calls, 1)
    assert.ok(store.get('porkbun', 'example.com'))
  } finally { store.close() }
})

test('refreshDomain 失败时重试，达到上限后记录错误', async () => {
  const store = new PriceStore({ path: ':memory:' })
  try {
    const adapter = countingAdapter('porkbun', new Error('网络不可达'))
    const { sleep, waits } = recordingSleep()
    const result = await refreshDomain('example.com', [adapter], store, { sleep, maxRetries: 3 })

    assert.equal(adapter.calls, 3, '应重试到上限')
    assert.equal(result.saved.length, 0)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0].message, /网络不可达/)
    // 指数退避：1.1s, 2.2s（第三次不再重试，故无第三次退避），外加出队间隔
    assert.ok(waits.some(w => w === 1100), `应含首次退避，实际 ${JSON.stringify(waits)}`)
  } finally { store.close() }
})

test('refreshDomain 遇到 429 时按 Retry-After 暂停整个队列', async () => {
  const store = new PriceStore({ path: ':memory:' })
  try {
    let calls = 0
    const adapter: RegistrarAdapter = {
      id: 'porkbun', name: 'Porkbun',
      async fetchQuote() {
        calls += 1
        if (calls === 1) throw new Error('HTTP 429; Retry-After: 20')
        return quote()
      },
    }
    const { sleep, waits } = recordingSleep()
    const events: string[] = []
    const result = await refreshDomain('example.com', [adapter], store, {
      sleep,
      onProgress: e => events.push(e.type),
    })

    assert.ok(waits.includes(20_000), `应暂停 20 秒，实际 ${JSON.stringify(waits)}`)
    assert.ok(events.includes('rate-limited'), '应发出限流事件')
    assert.equal(result.saved.length, 1, '限流恢复后应成功')
  } finally { store.close() }
})

test('refreshDomain 无 Retry-After 时使用默认暂停时长', async () => {
  const store = new PriceStore({ path: ':memory:' })
  try {
    let calls = 0
    const adapter: RegistrarAdapter = {
      id: 'x', name: 'X',
      async fetchQuote() {
        calls += 1
        if (calls === 1) throw new Error('HTTP 429 Too Many Requests')
        return quote({ registrar: 'x' })
      },
    }
    const { sleep, waits } = recordingSleep()
    await refreshDomain('example.com', [adapter], store, { sleep, rateLimitPauseMs: 7500 })
    assert.ok(waits.includes(7500), `应使用默认暂停时长，实际 ${JSON.stringify(waits)}`)
  } finally { store.close() }
})

test('refreshDomain 中某一家失败不影响其他家', async () => {
  const store = new PriceStore({ path: ':memory:' })
  try {
    const ok = countingAdapter('good', quote({ registrar: 'good' }))
    const bad = countingAdapter('bad', new Error('挂了'))
    const { sleep } = recordingSleep()

    const result = await refreshDomain('example.com', [ok, bad], store, { sleep, maxRetries: 1 })
    assert.equal(result.saved.length, 1)
    assert.equal(result.saved[0].registrar, 'good')
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].registrar, 'bad')
    assert.ok(store.get('good', 'example.com'))
  } finally { store.close() }
})

test('refreshDomain 每次出队后都留出节流间隔', async () => {
  const store = new PriceStore({ path: ':memory:' })
  try {
    const a = countingAdapter('a', quote({ registrar: 'a' }))
    const b = countingAdapter('b', quote({ registrar: 'b' }))
    const { sleep, waits } = recordingSleep()

    await refreshDomain('example.com', [a, b], store, { sleep, minIntervalMs: 500 })
    // 两家各自出队后各等一次
    assert.equal(waits.filter(w => w === 500).length, 2, `实际 ${JSON.stringify(waits)}`)
  } finally { store.close() }
})

test('refreshDomains 串行处理多个域名并汇总报告', async () => {
  const store = new PriceStore({ path: ':memory:' })
  try {
    const adapter: RegistrarAdapter = {
      id: 'porkbun', name: 'Porkbun',
      async fetchQuote(domain) { return quote({ domain }) },
    }
    const { sleep } = recordingSleep()
    const report = await refreshDomains(['a.com', 'b.com', 'c.com'], [adapter], store, { sleep })

    assert.equal(report.refreshed, 3)
    assert.equal(report.failed, 0)
    assert.equal(store.stats().domains, 3)
  } finally { store.close() }
})

test('refreshDomains 汇总失败域名的错误', async () => {
  const store = new PriceStore({ path: ':memory:' })
  try {
    const adapter: RegistrarAdapter = {
      id: 'x', name: 'X',
      async fetchQuote() { throw new Error('服务不可用') },
    }
    const { sleep } = recordingSleep()
    const report = await refreshDomains(['a.com', 'b.com'], [adapter], store, { sleep, maxRetries: 1 })

    assert.equal(report.refreshed, 0)
    assert.equal(report.failed, 2)
    assert.equal(report.errors.length, 2)
    assert.ok(report.errors.every(e => /服务不可用/.test(e.message)))
  } finally { store.close() }
})

test('refreshStale 无过期数据时不发起请求', async () => {
  const store = new PriceStore({ path: ':memory:', ttlMs: 60_000 })
  try {
    const adapter = countingAdapter('porkbun', quote())
    const { sleep } = recordingSleep()

    store.save(quote())
    const fresh = await refreshStale([adapter], store, { sleep })
    assert.equal(fresh.refreshed, 0)
    assert.equal(adapter.calls, 0, '数据新鲜时不应发起请求')
  } finally { store.close() }
})

test('refreshStale 会刷新过期数据', async () => {
  const store = new PriceStore({ path: ':memory:', ttlMs: 0 })
  try {
    store.save(quote())
    const adapter = countingAdapter('porkbun', quote())
    const { sleep } = recordingSleep()

    const report = await refreshStale([adapter], store, { sleep })
    assert.equal(report.refreshed, 1)
    assert.equal(adapter.calls, 1, '过期数据应触发刷新')
  } finally { store.close() }
})

test('refreshDomain 请求超时会被中断并计入失败', async () => {
  const store = new PriceStore({ path: ':memory:' })
  try {
    const adapter: RegistrarAdapter = {
      id: 'slow', name: 'Slow',
      fetchQuote: (_d, options) => new Promise((_res, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('请求超时')), { once: true })
      }),
    }
    const { sleep } = recordingSleep()
    const result = await refreshDomain('example.com', [adapter], store, { sleep, maxRetries: 1, timeoutMs: 50 })

    assert.equal(result.saved.length, 0)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0].message, /超时/)
  } finally { store.close() }
})
