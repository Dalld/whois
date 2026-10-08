import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parsePorkbunPricingApi, PorkbunTldApiSource } from '../src/lib/pricing/porkbun-tld-api'

/** 取自真实接口的响应结构 */
const SAMPLE = {
  status: 'SUCCESS',
  pricing: {
    com: { registration: '11.08', renewal: '11.08', transfer: '11.08', coupons: [] },
    cx: { registration: '16.53', renewal: '16.75', transfer: '16.53', coupons: [] },
    gg: { registration: '51.80', renewal: '51.80', transfer: '51.80', coupons: [] },
    'co.uk': { registration: '5.66', renewal: '5.66', transfer: '0.00', coupons: [] },
    'ac.nz': { registration: '14.98', renewal: '15.68', transfer: '15.68', coupons: [] },
  },
  requestId: 'abc',
}

describe('Porkbun 公开价目接口解析', () => {
  const prices = parsePorkbunPricingApi(SAMPLE, '2026-01-01T00:00:00.000Z')
  const get = (tld: string) => prices.find(p => p.tld === tld)

  test('解析全部 TLD', () => {
    assert.equal(prices.length, 5)
  })

  test('价格从字符串转为数值', () => {
    const c = get('com')
    assert.equal(c?.register, 11.08)
    assert.equal(c?.renew, 11.08)
    assert.equal(c?.transfer, 11.08)
  })

  test('注册价与续费价不同时分别保留（.cx）', () => {
    const cx = get('cx')
    assert.equal(cx?.register, 16.53)
    assert.equal(cx?.renew, 16.75)
  })

  test('transfer 为 "0.00" 时记为 null，不当作免费', () => {
    const uk = get('co.uk')
    assert.equal(uk?.register, 5.66)
    assert.equal(uk?.transfer, null, '0 应视为不支持，而非免费')
  })

  test('多段后缀正常解析', () => {
    assert.equal(get('ac.nz')?.renew, 15.68)
  })

  test('标记来源为 api 而非 crawled', () => {
    assert.equal(get('com')?.source, 'api')
  })

  test('接口不区分促销，故 onSale 为 false 且标准价等于注册价', () => {
    const c = get('com')!
    assert.equal(c.onSale, false)
    assert.equal(c.regularRegister, c.register)
  })

  test('数值型价格同样接受', () => {
    const out = parsePorkbunPricingApi({ status: 'SUCCESS', pricing: { x: { registration: 5, renewal: 6 } } })
    assert.equal(out[0].register, 5)
    assert.equal(out[0].renew, 6)
  })

  test('价格均为空或 0 的条目被跳过', () => {
    const out = parsePorkbunPricingApi({ status: 'SUCCESS', pricing: {
      good: { registration: '5.00', renewal: '5.00' },
      zero: { registration: '0.00', renewal: '0.00' },
      empty: {},
    } })
    assert.deepEqual(out.map(p => p.tld), ['good'])
  })

  test('pricing 缺失时返回空数组', () => {
    assert.deepEqual(parsePorkbunPricingApi({ status: 'SUCCESS' }), [])
    assert.deepEqual(parsePorkbunPricingApi({}), [])
  })

  test('结果按 TLD 排序', () => {
    const sorted = [...prices].sort((a, b) => a.tld.localeCompare(b.tld))
    assert.deepEqual(prices.map(p => p.tld), sorted.map(p => p.tld))
  })

  test('前导点与大小写被规范化', () => {
    const out = parsePorkbunPricingApi({ status: 'SUCCESS', pricing: { '.CX': { registration: '1.00', renewal: '1.00' } } })
    assert.equal(out[0].tld, 'cx')
  })
})

describe('Porkbun 价目接口抓取源', () => {
  test('status 非 SUCCESS 时报错', async () => {
    const real = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: 'ERROR' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as typeof fetch
    try {
      await assert.rejects(() => new PorkbunTldApiSource().fetchAll(), /返回 ERROR/)
    } finally {
      globalThis.fetch = real
    }
  })

  test('HTTP 错误时报错并带状态码', async () => {
    const real = globalThis.fetch
    globalThis.fetch = (async () => new Response('', { status: 502 })) as typeof fetch
    try {
      await assert.rejects(() => new PorkbunTldApiSource().fetchAll(), /HTTP 502/)
    } finally {
      globalThis.fetch = real
    }
  })

  test('响应为空时报错，不静默返回空列表', async () => {
    const real = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: 'SUCCESS', pricing: {} }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as typeof fetch
    try {
      await assert.rejects(() => new PorkbunTldApiSource().fetchAll(), /结构可能已变更/)
    } finally {
      globalThis.fetch = real
    }
  })

  test('超时会中断', async () => {
    const real = globalThis.fetch
    globalThis.fetch = ((_u: any, init: any) => new Promise((_r, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))
    })) as typeof fetch
    try {
      await assert.rejects(() => new PorkbunTldApiSource().fetchAll({ timeoutMs: 50 }))
    } finally {
      globalThis.fetch = real
    }
  })

  test('正常响应可解析', async () => {
    const real = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify(SAMPLE), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as typeof fetch
    try {
      const out = await new PorkbunTldApiSource().fetchAll()
      assert.equal(out.length, 5)
    } finally {
      globalThis.fetch = real
    }
  })
})
