import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parsePorkbunPricing, PorkbunTldSource } from '../src/lib/pricing/porkbun-tld'
import { tldCandidates, normalizeTld, sortKey } from '../src/lib/pricing/tld-types'

/**
 * 固定样本，取自 Porkbun 定价页真实结构。
 * 用固定样本而非联网，保证测试稳定且能回归页面改版。
 */
const SAMPLE_HTML = `
<div>
  <table><tr><th>extension</th><th>registration</th><th>renewal</th><th>transfer</th></tr>
  <tr><td>.abogado</td><td>$ 26.26</td><td>$ 26.26</td><td>$ 26.26</td></tr>
  <tr><td>.ac</td><td>$46.65 1st Yr Sale! $ 26.06</td><td>$ 46.65</td><td>$ 46.65</td></tr>
  </table>
  <p>.com $ 11.08 $ 11.08 $ 11.08</p>
  <p>.xyz $14.21 1st Yr Sale! $ 2.04 $ 14.21 $ 14.21</p>
  <p>.cx $ 16.53 $ 16.75 $ 16.53</p>
  <p>.io $51.80 1st Yr Sale! $ 28.12 $ 51.80 $ 51.80</p>
  <p>.ac.nz $ 14.98 $ 15.68 $ 15.68</p>
  <p>.网站 $ 11.84 $ 11.84 $ 11.84</p>
</div>
`

describe('Porkbun 后缀价格解析', () => {
  const prices = parsePorkbunPricing(SAMPLE_HTML, '2026-01-01T00:00:00.000Z')
  const get = (tld: string) => prices.find(p => p.tld === tld)

  test('解析常规行', () => {
    const c = get('com')
    assert.ok(c)
    assert.equal(c.register, 11.08)
    assert.equal(c.renew, 11.08)
    assert.equal(c.transfer, 11.08)
    assert.equal(c.onSale, false)
  })

  test('促销行的首年价取促销价，不是标准价', () => {
    const x = get('xyz')
    assert.ok(x)
    // 页面写作 `.xyz $14.21 1st Yr Sale! $ 2.04 ...`
    // 标准价 14.21，促销后首年 2.04 —— 用户实付 2.04
    assert.equal(x.register, 2.04)
    assert.equal(x.regularRegister, 14.21)
    assert.equal(x.onSale, true)
  })

  test('促销不影响续费价与转移价', () => {
    const x = get('xyz')
    assert.equal(x!.renew, 14.21)
    assert.equal(x!.transfer, 14.21)
  })

  test('促销价必须低于标准价才判定为促销', () => {
    // 若数字反常（促销价反而更高），不应误判
    const odd = parsePorkbunPricing('.tld $ 5.00 1st Yr Sale! $ 9.00 $ 9.00 $ 9.00')
    const t = odd.find(p => p.tld === 'tld')
    assert.equal(t?.onSale, false)
    assert.equal(t?.register, 5)
  })

  test('注册价与续费价不同的后缀（.cx）正确保留差异', () => {
    const cx = get('cx')
    assert.equal(cx?.register, 16.53)
    assert.equal(cx?.renew, 16.75)
    assert.equal(cx?.transfer, 16.53)
  })

  test('两段式后缀 ac.nz 可解析', () => {
    const ac = get('ac.nz')
    assert.ok(ac)
    assert.equal(ac.register, 14.98)
    assert.equal(ac.renew, 15.68)
  })

  test('IDN 后缀可解析', () => {
    const idn = get('网站')
    assert.ok(idn, '应能解析中文 IDN 后缀')
    assert.equal(idn.register, 11.84)
  })

  test('表格内的行同样被解析', () => {
    assert.ok(get('abogado'))
    assert.ok(get('ac'))
  })

  test('不产生重复 TLD', () => {
    assert.equal(prices.length, new Set(prices.map(p => p.tld)).size)
  })

  test('结果按 TLD 排序，便于二分查找', () => {
    const sorted = [...prices].sort((a, b) => a.tld.localeCompare(b.tld))
    assert.deepEqual(prices.map(p => p.tld), sorted.map(p => p.tld))
  })

  test('记录数据源与抓取时间', () => {
    const c = get('com')!
    assert.equal(c.source, 'crawled')
    assert.equal(c.registrar, 'porkbun')
    assert.equal(c.currency, 'USD')
    assert.equal(c.fetchedAt, '2026-01-01T00:00:00.000Z')
  })

  test('空内容返回空数组（由调用方判定为异常）', () => {
    assert.deepEqual(parsePorkbunPricing(''), [])
    assert.deepEqual(parsePorkbunPricing('<html><body>改版了</body></html>'), [])
  })

  test('script 与 style 内容不会污染解析', () => {
    const html = `<script>var x = ".evil $ 1.00 $ 1.00 $ 1.00";</script>
      <style>.css $ 2.00 $ 2.00 $ 2.00 {}</style>
      <p>.good $ 3.00 $ 3.00 $ 3.00</p>`
    const out = parsePorkbunPricing(html)
    assert.deepEqual(out.map(p => p.tld), ['good'])
  })
})

describe('Porkbun 抓取源', () => {
  test('解析为空时抛错，不静默返回空列表', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('<html>已改版</html>', { status: 200 })) as typeof fetch
    try {
      const src = new PorkbunTldSource()
      await assert.rejects(() => src.fetchAll(), /结构可能已改版/)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('HTTP 错误时报错并带状态码', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch
    try {
      await assert.rejects(() => new PorkbunTldSource().fetchAll(), /HTTP 503/)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('超时会中断', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = ((_u: any, init: any) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))
    })) as typeof fetch
    try {
      await assert.rejects(() => new PorkbunTldSource().fetchAll({ timeoutMs: 50 }))
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('带 User-Agent 标识', async () => {
    const realFetch = globalThis.fetch
    let ua = ''
    globalThis.fetch = ((_u: any, init: any) => {
      ua = init?.headers?.['User-Agent'] || ''
      return Promise.resolve(new Response(SAMPLE_HTML, { status: 200 }))
    }) as typeof fetch
    try {
      await new PorkbunTldSource().fetchAll()
      assert.match(ua, /whois-tld-compare/)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('TLD 解析工具', () => {
  test('normalizeTld 去掉前导点并小写', () => {
    assert.equal(normalizeTld('.CX'), 'cx')
    assert.equal(normalizeTld('cx'), 'cx')
    assert.equal(normalizeTld('..cx'), 'cx')
  })

  test('tldCandidates 最长优先，且不含 SLD 本身', () => {
    // a.b.co.uk：后缀部分为 b.co.uk / co.uk / uk，最长优先
    assert.deepEqual(tldCandidates('a.b.co.uk'), ['b.co.uk', 'co.uk', 'uk'])
    // feng.cx：cx 才是后缀，feng.cx 不是
    assert.deepEqual(tldCandidates('feng.cx'), ['cx'])
  })

  test('tldCandidates 对单段输入返回空', () => {
    assert.deepEqual(tldCandidates('localhost'), [])
    assert.deepEqual(tldCandidates(''), [])
  })

  test('sortKey 优先续费价，缺失时回落注册价', () => {
    const base = { tld: 'x', registrar: 'r', registrarName: 'R', transfer: null,
      regularRegister: null, onSale: false, currency: 'USD' as const,
      source: 'crawled' as const, website: '', fetchedAt: '' }
    assert.equal(sortKey({ ...base, register: 5, renew: 20 }), 20)
    assert.equal(sortKey({ ...base, register: 5, renew: null }), 5)
    assert.equal(sortKey({ ...base, register: null, renew: null }), Number.POSITIVE_INFINITY)
  })
})
