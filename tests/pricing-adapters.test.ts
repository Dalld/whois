import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CloudflareAdapter, describeReason } from '../src/lib/pricing/cloudflare'
import { SpaceshipAdapter } from '../src/lib/pricing/spaceship'
import { adapterStatus, buildAdapters } from '../src/lib/pricing/registry'
import { comparePrices } from '../src/lib/pricing/compare'

/** 临时替换 globalThis.fetch 并捕获请求 */
function withFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  run: (calls: { url: string; init: RequestInit }[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch
  const calls: { url: string; init: RequestInit }[] = []
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }) as typeof fetch
  return run(calls).finally(() => { globalThis.fetch = original })
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/* ------------------------------------------------------------------ */
/* Cloudflare                                                          */
/* ------------------------------------------------------------------ */

/** 官方文档给出的 Check 响应示例 */
const cfOk = (over: Record<string, unknown> = {}) => ({
  success: true, errors: [], messages: [],
  result: {
    domains: [{
      name: 'acmecorp.dev',
      registrable: true,
      tier: 'standard',
      pricing: { currency: 'USD', registration_cost: '10.11', renewal_cost: '10.11' },
      ...over,
    }],
  },
})

test('Cloudflare adapter 映射注册价与续费价', async () => {
  await withFetch(() => json(cfOk()), async calls => {
    const q = await new CloudflareAdapter({ accountId: 'acc', apiToken: 'tok' }).fetchQuote('ACMECORP.DEV')

    assert.equal(q.registrar, 'cloudflare')
    assert.equal(q.domain, 'acmecorp.dev', '应归一化为小写')
    assert.equal(q.tld, 'dev')
    assert.equal(q.available, true)
    assert.equal(q.premium, false)
    assert.equal(q.currency, 'USD')
    assert.equal(q.register?.price, 10.11, 'registration_cost 是字符串，须转数值')
    assert.equal(q.renew?.price, 10.11)
    assert.equal(q.transfer, null, '官方明确 transfers 暂不支持 API')

    // 请求应打到真实端点，且带 Bearer token
    assert.ok(calls[0].url.includes('/accounts/acc/registrar/domain-check'), calls[0].url)
    const headers = calls[0].init.headers as Record<string, string>
    assert.equal(headers.Authorization, 'Bearer tok')
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { domains: ['acmecorp.dev'] })
  })
})

test('Cloudflare adapter 区分溢价域名', async () => {
  await withFetch(
    () => json(cfOk({ tier: 'premium', pricing: { currency: 'USD', registration_cost: '1250.00', renewal_cost: '1250.00' } })),
    async () => {
      const q = await new CloudflareAdapter({ accountId: 'a', apiToken: 't' }).fetchQuote('premium.dev')
      assert.equal(q.premium, true)
      assert.equal(q.register?.price, 1250)
    },
  )
})

test('Cloudflare adapter 对不可注册域名保留 reason 而非静默丢弃', async () => {
  await withFetch(
    () => json({
      success: true, errors: [], messages: [],
      result: { domains: [{ name: 'mybrand.uk', registrable: false, reason: 'extension_not_supported_via_api' }] },
    }),
    async () => {
      const q = await new CloudflareAdapter({ accountId: 'a', apiToken: 't' }).fetchQuote('mybrand.uk')
      assert.equal(q.available, false)
      assert.equal(q.register, null, '无 pricing 时价格应为 null')
      assert.equal(q.renew, null)
      // reason 必须保留，否则用户不知道为什么没价格
      assert.equal((q.raw as { reason?: string }).reason, 'extension_not_supported_via_api')
    },
  )
})

test('describeReason 把官方 reason 译成可读文本', () => {
  assert.equal(describeReason('domain_unavailable'), '域名已被注册')
  assert.equal(describeReason('extension_not_supported_via_api'), '该后缀暂不支持通过 API 查询')
  assert.equal(describeReason('domain_premium'), '溢价域名，API 暂不支持')
  assert.equal(describeReason('some_new_reason'), 'some_new_reason', '未知原因应原样返回')
  assert.equal(describeReason(undefined), '不可注册')
})

test('Cloudflare adapter 单次超过 20 个域名时自动分批', async () => {
  const domains = Array.from({ length: 45 }, (_, i) => `d${i}.dev`)
  await withFetch(
    (_url, init) => {
      const sent = (JSON.parse(String(init.body)) as { domains: string[] }).domains
      return json({
        success: true, errors: [], messages: [],
        result: { domains: sent.map(name => ({ name, registrable: true, tier: 'standard', pricing: { currency: 'USD', registration_cost: '10.00', renewal_cost: '10.00' } })) },
      })
    },
    async calls => {
      const out = await new CloudflareAdapter({ accountId: 'a', apiToken: 't' }).fetchQuotes(domains)
      assert.equal(calls.length, 3, '45 个域名应分 3 批（20+20+5）')
      assert.equal(out.length, 45)
      for (const c of calls) {
        const sent = (JSON.parse(String(c.init.body)) as { domains: string[] }).domains
        assert.ok(sent.length <= 20, `单批不得超过 20，实际 ${sent.length}`)
      }
    },
  )
})

test('Cloudflare adapter 未配置凭证时明确报错', async () => {
  const adapter = new CloudflareAdapter({})
  assert.equal(adapter.isConfigured, false)
  await assert.rejects(() => adapter.fetchQuote('example.com'), /未配置 accountId \/ apiToken/)

  // 只有一半凭证也应视为未配置
  assert.equal(new CloudflareAdapter({ accountId: 'a' }).isConfigured, false)
  assert.equal(new CloudflareAdapter({ apiToken: 't' }).isConfigured, false)
})

test('Cloudflare adapter 在 HTTP 错误时带出接口返回的详情', async () => {
  await withFetch(
    () => json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, 403),
    async () => {
      await assert.rejects(
        () => new CloudflareAdapter({ accountId: 'a', apiToken: 'bad' }).fetchQuote('example.com'),
        /HTTP 403：Authentication error/,
      )
    },
  )
})

/* ------------------------------------------------------------------ */
/* Spaceship                                                           */
/* ------------------------------------------------------------------ */

/** 官方文档给出的响应示例 */
const spOk = (over: Record<string, unknown> = {}) => ({
  domains: [{
    domain: 'spaceship.dev',
    result: 'available',
    premiumPricing: [
      { operation: 'register', price: 10.99, currency: 'USD' },
      { operation: 'renew', price: 12.5, currency: 'USD' },
      { operation: 'transfer', price: 10.99, currency: 'USD' },
    ],
    ...over,
  }],
})

test('Spaceship adapter 从 premiumPricing 数组按 operation 取价', async () => {
  await withFetch(() => json(spOk()), async calls => {
    const q = await new SpaceshipAdapter({ apiKey: 'k', apiSecret: 's' }).fetchQuote('spaceship.dev')

    assert.equal(q.registrar, 'spaceship')
    assert.equal(q.available, true)
    assert.equal(q.register?.price, 10.99)
    assert.equal(q.renew?.price, 12.5)
    assert.equal(q.transfer?.price, 10.99)
    assert.equal(q.premium, false, '普通价位不应判为溢价')

    const headers = calls[0].init.headers as Record<string, string>
    assert.equal(headers['X-Api-Key'], 'k')
    assert.equal(headers['X-Api-Secret'], 's')
  })
})

test('Spaceship adapter 缺失的 operation 返回 null 而不是 0', async () => {
  await withFetch(
    () => json(spOk({ premiumPricing: [{ operation: 'register', price: 10.99, currency: 'USD' }] })),
    async () => {
      const q = await new SpaceshipAdapter({ apiKey: 'k', apiSecret: 's' }).fetchQuote('spaceship.dev')
      assert.equal(q.register?.price, 10.99)
      assert.equal(q.renew, null, '没有 renew 条目时应为 null')
      assert.equal(q.transfer, null)
    },
  )
})

test('Spaceship adapter 识别高价域名', async () => {
  await withFetch(
    () => json(spOk({ premiumPricing: [{ operation: 'register', price: 1250, currency: 'USD' }] })),
    async () => {
      const q = await new SpaceshipAdapter({ apiKey: 'k', apiSecret: 's' }).fetchQuote('expensive.dev')
      assert.equal(q.premium, true, '高价域名应标记为溢价')
    },
  )
})

test('Spaceship adapter 处理不可注册域名', async () => {
  await withFetch(
    () => json({ domains: [{ domain: 'taken.dev', result: 'unavailable' }] }),
    async () => {
      const q = await new SpaceshipAdapter({ apiKey: 'k', apiSecret: 's' }).fetchQuote('taken.dev')
      assert.equal(q.available, false)
      assert.equal(q.register, null)
    },
  )
})

test('Spaceship adapter 未配置凭证时明确报错', async () => {
  const adapter = new SpaceshipAdapter({})
  assert.equal(adapter.isConfigured, false)
  await assert.rejects(() => adapter.fetchQuote('example.com'), /未配置 apiKey \/ apiSecret/)
})

test('Spaceship adapter 在 HTTP 错误时抛出状态码', async () => {
  await withFetch(
    () => json({ message: 'Unauthorized' }, 401),
    async () => {
      await assert.rejects(
        () => new SpaceshipAdapter({ apiKey: 'k', apiSecret: 'bad' }).fetchQuote('example.com'),
        /HTTP 401：Unauthorized/,
      )
    },
  )
})

/* ------------------------------------------------------------------ */
/* 装配与多源聚合                                                      */
/* ------------------------------------------------------------------ */

test('buildAdapters 只装配已配置的注册商，Porkbun 始终可用', () => {
  const none = buildAdapters({})
  assert.deepEqual(none.map(a => a.id), ['porkbun'], '未配置任何凭证时只剩 Porkbun（走 mock）')

  const all = buildAdapters({
    CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't',
    PORKBUN_API_KEY: 'k', PORKBUN_SECRET_KEY: 's',
    SPACESHIP_API_KEY: 'sk', SPACESHIP_API_SECRET: 'ss',
  })
  assert.deepEqual(all.map(a => a.id).sort(), ['cloudflare', 'porkbun', 'spaceship'])

  // 只配一半凭证不应装配
  const half = buildAdapters({ CLOUDFLARE_ACCOUNT_ID: 'a', SPACESHIP_API_KEY: 'sk' })
  assert.deepEqual(half.map(a => a.id), ['porkbun'])
})

test('adapterStatus 反映各家配置状态', () => {
  const st = adapterStatus({ CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' })
  assert.equal(st.find(s => s.id === 'cloudflare')?.configured, true)
  assert.equal(st.find(s => s.id === 'porkbun')?.configured, false)
  assert.equal(st.find(s => s.id === 'spaceship')?.configured, false)
  assert.equal(st.length, 3)
})

test('三家注册商结果可聚合，按续费价选出最低', async () => {
  const cf = new CloudflareAdapter({ accountId: 'a', apiToken: 't' })
  const pb = {
    id: 'porkbun', name: 'Porkbun',
    fetchQuote: async (domain: string) => ({
      registrar: 'porkbun', registrarName: 'Porkbun', domain, tld: 'dev',
      available: true, premium: false, currency: 'USD' as const,
      register: { price: 9.73, regularPrice: 9.73, onSale: false },
      renew: { price: 11.06, regularPrice: 11.06, onSale: false },
      transfer: null, minDuration: 1, fetchedAt: new Date().toISOString(), source: 'live' as const,
    }),
  }
  const sp = new SpaceshipAdapter({ apiKey: 'k', apiSecret: 's' })

  const original = globalThis.fetch
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).includes('cloudflare')) {
      return json({ success: true, errors: [], messages: [], result: { domains: [{ name: 'acmecorp.dev', registrable: true, tier: 'standard', pricing: { currency: 'USD', registration_cost: '10.11', renewal_cost: '10.11' } }] } })
    }
    return json({ domains: [{ domain: 'acmecorp.dev', result: 'available', premiumPricing: [{ operation: 'register', price: 8.5, currency: 'USD' }, { operation: 'renew', price: 9.98, currency: 'USD' }] }] })
  }) as typeof fetch

  try {
    const result = await comparePrices('acmecorp.dev', [cf, pb, sp])
    assert.equal(result.quotes.length, 3)
    assert.equal(result.cheapest?.registrar, 'spaceship', '续费 $9.98 最低')
    assert.deepEqual(result.quotes.map(q => q.registrar), ['spaceship', 'cloudflare', 'porkbun'])
    assert.equal(result.errors.length, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('某家未配置时不参与聚合，也不产生错误', async () => {
  const pb = {
    id: 'porkbun', name: 'Porkbun',
    fetchQuote: async (domain: string) => ({
      registrar: 'porkbun', registrarName: 'Porkbun', domain, tld: 'dev',
      available: true, premium: false, currency: 'USD' as const,
      register: { price: 9.73, regularPrice: 9.73, onSale: false },
      renew: { price: 11.06, regularPrice: 11.06, onSale: false },
      transfer: null, minDuration: 1, fetchedAt: new Date().toISOString(), source: 'live' as const,
    }),
  }
  // buildAdapters 不会装配未配置的 Cloudflare，因此不会发生必然失败的请求
  const adapters = buildAdapters({})
  const result = await comparePrices('example.dev', [...adapters.filter(a => a.id !== 'porkbun'), pb])
  assert.equal(result.quotes.length, 1)
  assert.equal(result.errors.length, 0)
})
