import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractTld, makeQuote, parsePrice, parseYesNo } from '../src/lib/pricing/types'
import { comparePrices, sortPrice } from '../src/lib/pricing/compare'
import { PorkbunAdapter } from '../src/lib/pricing/porkbun'
import type { RegistrarAdapter, RegistrarQuote } from '../src/lib/pricing/types'

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

test('extractTld 处理单段、多段与两段式公共后缀', () => {
  assert.equal(extractTld('example.com'), 'com')
  assert.equal(extractTld('a.b.example.co.uk'), 'co.uk')
  assert.equal(extractTld('baidu.com.cn'), 'com.cn')
  assert.equal(extractTld('EXAMPLE.COM'), 'com')
  assert.equal(extractTld('example.com.'), 'com')
  assert.equal(extractTld('localhost'), '')
  assert.equal(extractTld(''), '')
})

test('parsePrice 解析各家格式，无法解析时返回 null 而非 0', () => {
  assert.equal(parsePrice('9.73'), 9.73)
  assert.equal(parsePrice('$9.73'), 9.73)
  assert.equal(parsePrice('10.11 USD'), 10.11)
  assert.equal(parsePrice(12.5), 12.5)
  assert.equal(parsePrice('1,234.56'), 1234.56)
  // 关键：0 会被误认为免费，无法解析必须返回 null
  assert.equal(parsePrice(''), null)
  assert.equal(parsePrice('免费'), null)
  assert.equal(parsePrice(null), null)
  assert.equal(parsePrice(undefined), null)
  assert.equal(parsePrice(NaN), null)
  assert.equal(parsePrice({}), null)
})

test('parseYesNo 只认 yes', () => {
  assert.equal(parseYesNo('yes'), true)
  assert.equal(parseYesNo('YES'), true)
  assert.equal(parseYesNo(' yes '), true)
  assert.equal(parseYesNo('no'), false)
  assert.equal(parseYesNo(''), false)
  assert.equal(parseYesNo(null), false)
  assert.equal(parseYesNo(undefined), false)
})

test('makeQuote 区分促销价与标准价', () => {
  const promo = makeQuote('8.88', '11.39')
  assert.ok(promo)
  assert.equal(promo.price, 8.88)
  assert.equal(promo.regularPrice, 11.39)
  assert.equal(promo.onSale, true)

  const flat = makeQuote('9.73', '9.73')
  assert.ok(flat)
  assert.equal(flat.onSale, false)

  // 显式标记优先于价格差推断
  const explicit = makeQuote('9.73', '9.73', true)
  assert.ok(explicit)
  assert.equal(explicit.onSale, true)

  // 只有一个价格时另一个回落，不应报 null
  const onlyActual = makeQuote('9.73', undefined)
  assert.ok(onlyActual)
  assert.equal(onlyActual.regularPrice, 9.73)

  const onlyRegular = makeQuote(undefined, '9.73')
  assert.ok(onlyRegular)
  assert.equal(onlyRegular.price, 9.73)

  // 两者都缺失才返回 null
  assert.equal(makeQuote(undefined, undefined), null)
})

/* ------------------------------------------------------------------ */
/* Porkbun adapter —— 基于官方 /mock 端点实测到的真实结构               */
/* ------------------------------------------------------------------ */

const porkbunPayload = (over: Record<string, unknown> = {}) => ({
  status: 'SUCCESS',
  response: {
    avail: 'yes',
    type: 'registration',
    price: '9.73',
    firstYearPromo: 'yes',
    regularPrice: '9.73',
    premium: 'no',
    minDuration: 1,
    additional: {
      renewal: { type: 'renewal', price: '11.06', regularPrice: '11.06' },
      transfer: { type: 'transfer', price: '9.73', regularPrice: '9.73' },
    },
    ...over,
  },
})

function stubAdapter(quotes: Record<string, RegistrarQuote | Error>): RegistrarAdapter {
  return {
    id: 'stub',
    name: 'Stub',
    async fetchQuote(domain: string) {
      const v = quotes[domain]
      if (v instanceof Error) throw v
      if (!v) throw new Error('not found')
      return v
    },
  }
}

function quote(over: Partial<RegistrarQuote> = {}): RegistrarQuote {
  return {
    registrar: 'x', registrarName: 'X', domain: 'example.com', tld: 'com',
    available: true, premium: false, currency: 'USD',
    register: { price: 10, regularPrice: 10, onSale: false },
    renew: { price: 10, regularPrice: 10, onSale: false },
    transfer: null, minDuration: 1, fetchedAt: new Date().toISOString(),
    source: 'live', ...over,
  }
}

test('Porkbun adapter 映射真实字段：注册价、续费价、转移价、溢价与促销标记', async () => {
  const originalFetch = globalThis.fetch
  let calledUrl = ''
  globalThis.fetch = (async (url: string) => {
    calledUrl = String(url)
    return new Response(JSON.stringify(porkbunPayload()), { status: 200 })
  }) as typeof fetch

  try {
    const adapter = new PorkbunAdapter({ apiKey: 'pk1_live_x', secretApiKey: 's' })
    const q = await adapter.fetchQuote('Example.COM')

    assert.equal(q.registrar, 'porkbun')
    assert.equal(q.domain, 'example.com', '域名应归一化为小写')
    assert.equal(q.tld, 'com')
    assert.equal(q.available, true)
    assert.equal(q.premium, false)
    assert.equal(q.currency, 'USD')
    assert.equal(q.source, 'live')
    assert.equal(q.minDuration, 1)

    assert.equal(q.register?.price, 9.73)
    assert.equal(q.register?.onSale, true, 'firstYearPromo=yes 应标记为促销')

    assert.equal(q.renew?.price, 11.06, '续费价必须与首年价分开')
    assert.equal(q.transfer?.price, 9.73)

    // 使用真实端点而非 mock
    assert.ok(calledUrl.includes('/domain/checkDomain/example.com'), calledUrl)
    assert.ok(!calledUrl.includes('/mock/'), '配置密钥后不应走 mock')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Porkbun adapter 无密钥时回落到 mock 端点并标记 source', async () => {
  const originalFetch = globalThis.fetch
  let calledUrl = ''
  globalThis.fetch = (async (url: string) => {
    calledUrl = String(url)
    return new Response(JSON.stringify(porkbunPayload()), { status: 200 })
  }) as typeof fetch

  try {
    const q = await new PorkbunAdapter().fetchQuote('example.com')
    assert.equal(q.source, 'mock')
    assert.ok(calledUrl.includes('/mock/domain/checkDomain/example.com'), calledUrl)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Porkbun adapter 识别 sandbox 密钥', async () => {
  const originalFetch = globalThis.fetch
  const headers: Record<string, string> = {}
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    Object.assign(headers, init.headers as Record<string, string>)
    return new Response(JSON.stringify(porkbunPayload()), { status: 200 })
  }) as typeof fetch

  try {
    const q = await new PorkbunAdapter({ apiKey: 'pk1_sb_test', secretApiKey: 's' }).fetchQuote('example.com')
    assert.equal(q.source, 'sandbox')
    assert.equal(headers['X-API-Key'], 'pk1_sb_test')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Porkbun adapter 在 HTTP 错误与业务失败时抛错', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = (async () => new Response('nope', { status: 429 })) as typeof fetch
    await assert.rejects(
      () => new PorkbunAdapter({ apiKey: 'pk1_live_x', secretApiKey: 's' }).fetchQuote('example.com'),
      /HTTP 429/,
    )

    globalThis.fetch = (async () => new Response(JSON.stringify({ status: 'ERROR', message: '额度不足' }), { status: 200 })) as typeof fetch
    await assert.rejects(
      () => new PorkbunAdapter({ apiKey: 'pk1_live_x', secretApiKey: 's' }).fetchQuote('example.com'),
      /额度不足/,
    )

    globalThis.fetch = (async () => new Response(JSON.stringify({ status: 'SUCCESS' }), { status: 200 })) as typeof fetch
    await assert.rejects(
      () => new PorkbunAdapter({ apiKey: 'pk1_live_x', secretApiKey: 's' }).fetchQuote('example.com'),
      /缺少 response/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Porkbun adapter 处理不可注册与溢价域名', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify(porkbunPayload({
    avail: 'no', premium: 'yes', price: '1250.00', regularPrice: '1250.00', firstYearPromo: 'no',
  })), { status: 200 })) as typeof fetch

  try {
    const q = await new PorkbunAdapter({ apiKey: 'pk1_live_x', secretApiKey: 's' }).fetchQuote('premium.com')
    assert.equal(q.available, false)
    assert.equal(q.premium, true)
    assert.equal(q.register?.price, 1250)
  } finally {
    globalThis.fetch = originalFetch
  }
})

/* ------------------------------------------------------------------ */
/* 聚合与排序                                                          */
/* ------------------------------------------------------------------ */

test('sortPrice 优先续费价，缺失时回落首年价，两者皆无排最后', () => {
  assert.equal(sortPrice(quote({ renew: { price: 11, regularPrice: 11, onSale: false } })), 11)
  assert.equal(sortPrice(quote({ renew: null, register: { price: 5, regularPrice: 5, onSale: false } })), 5)
  assert.equal(sortPrice(quote({ renew: null, register: null })), Number.POSITIVE_INFINITY)
})

test('比价按续费价排序，而非首年促销价', async () => {
  const trap = stubAdapter({
    'example.com': quote({
      registrar: 'trap', registrarName: 'Trap',
      register: { price: 0.99, regularPrice: 29, onSale: true },  // 首年极低
      renew: { price: 29, regularPrice: 29, onSale: false },      // 续费很贵
    }),
  })
  const honest = stubAdapter({
    'example.com': quote({
      registrar: 'honest', registrarName: 'Honest',
      register: { price: 10, regularPrice: 10, onSale: false },
      renew: { price: 11, regularPrice: 11, onSale: false },      // 续费便宜
    }),
  })

  const result = await comparePrices('example.com', [trap, honest])
  assert.equal(result.quotes.length, 2)
  assert.equal(result.cheapest?.registrar, 'honest', '应按续费价选出真正便宜的一家')
  assert.equal(result.quotes[0].registrar, 'honest')
})

test('单个注册商失败不影响整体，错误被收集', async () => {
  const good = stubAdapter({ 'example.com': quote({ registrar: 'good' }) })
  const bad = stubAdapter({ 'example.com': new Error('注册商超时') })

  const result = await comparePrices('example.com', [good, bad])
  assert.equal(result.quotes.length, 1)
  assert.equal(result.quotes[0].registrar, 'good')
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].registrar, 'stub')
  assert.match(result.errors[0].message, /超时/)
})

test('全部注册商失败时返回空报价与完整错误列表', async () => {
  const a = stubAdapter({ 'example.com': new Error('A 挂了') })
  const b = stubAdapter({ 'example.com': new Error('B 挂了') })

  const result = await comparePrices('example.com', [a, b])
  assert.equal(result.quotes.length, 0)
  assert.equal(result.cheapest, null)
  assert.equal(result.errors.length, 2)
})

test('比价结果包含域名与 TLD 归一化信息', async () => {
  const adapter = stubAdapter({ 'example.com': quote({ registrar: 'a' }) })
  const result = await comparePrices('  EXAMPLE.COM  ', [adapter])
  assert.equal(result.domain, 'example.com')
  assert.equal(result.tld, 'com')
  assert.ok(result.queriedAt)
})

test('价格相同时按注册商名稳定排序，避免顺序抖动', async () => {
  const mk = (id: string) => stubAdapter({
    'example.com': quote({ registrar: id, registrarName: id, renew: { price: 10, regularPrice: 10, onSale: false } }),
  })
  const r1 = await comparePrices('example.com', [mk('zeta'), mk('alpha'), mk('mid')])
  const r2 = await comparePrices('example.com', [mk('mid'), mk('zeta'), mk('alpha')])
  const order = (r: typeof r1) => r.quotes.map(q => q.registrar).join(',')
  assert.equal(order(r1), order(r2), '同样输入应得到稳定顺序')
  assert.equal(order(r1), 'alpha,mid,zeta')
})

test('超时的注册商被中断并计入错误', async () => {
  const slow: RegistrarAdapter = {
    id: 'slow', name: 'Slow',
    fetchQuote: (_d, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('已超时')), { once: true })
    }),
  }
  const fast = stubAdapter({ 'example.com': quote({ registrar: 'fast' }) })

  const result = await comparePrices('example.com', [fast, slow], { timeoutMs: 60 })
  assert.equal(result.quotes.length, 1)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0].message, /超时/)
})
