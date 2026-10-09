import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseGandiPage, GandiTldSource } from '../src/lib/pricing/gandi-tld'

/**
 * 页面结构取自实测：Gandi 后缀页剥掉标签后，
 * 价格表以 `<tld> domain prices` 开头，其后为
 * Registration / Transfer / Renewal 三组「标签 + 金额」。
 */
const gandiPage = (opts: {
  tld: string
  proseRegistration?: boolean
  registration?: string
  transfer?: string
  renewal?: string
  extraNoise?: string
}) => {
  const {
    tld,
    proseRegistration = false,
    registration = '$20.00',
    transfer = 'Free',
    renewal = '$39.98',
    extraNoise = '',
  } = opts
  return `<!DOCTYPE html><html><body>
    <p>The minimum ${proseRegistration ? 'registration' : ''} period is one year,
       with renewal on a yearly basis available beyond that.</p>
    <h2>.${tld} domain prices</h2>
    <table>
      <tr><td>Registration</td><td>${registration}</td><td>per year</td></tr>
      <tr><td>Transfer</td><td>${transfer}</td><td>Does not change the expiration date</td></tr>
      <tr><td>Renewal</td><td>${renewal}</td><td>per year</td></tr>
    </table>
    ${extraNoise}
  </body></html>`
}

describe('Gandi 后缀页解析', () => {
  test('解析注册价与续费价（二者不同）', () => {
    const p = parseGandiPage(gandiPage({ tld: 'im' }), 'im', '2026-01-01T00:00:00.000Z')
    assert.equal(p?.register, 20)
    assert.equal(p?.renew, 39.98, '.im 续费价与注册价不同，不能混用')
  })

  test('正文里出现 registration 一词不会干扰取值', () => {
    // 真实页面前文有 "The minimum registration period is one year"
    const withProse = parseGandiPage(gandiPage({ tld: 'im', proseRegistration: true }), 'im')
    const without = parseGandiPage(gandiPage({ tld: 'im', proseRegistration: false }), 'im')
    assert.equal(withProse?.register, 20)
    assert.deepEqual(withProse?.register, without?.register)
  })

  test('免费转入记为 null，不当作 0 元', () => {
    const p = parseGandiPage(gandiPage({ tld: 'im', transfer: 'Free' }), 'im')
    assert.equal(p?.transfer, null)
  })

  test('付费转入正常解析', () => {
    const p = parseGandiPage(gandiPage({ tld: 'al', registration: '$395.00', transfer: '$395.00', renewal: '$663.98' }), 'al')
    assert.equal(p?.register, 395)
    assert.equal(p?.transfer, 395)
    assert.equal(p?.renew, 663.98)
  })

  test('带千分位的金额可解析', () => {
    const p = parseGandiPage(gandiPage({ tld: 'x', registration: '$1,234.00' }), 'x')
    assert.equal(p?.register, 1234)
  })

  test('页面混有其他扩展名价格时不取错', () => {
    const noise = '<div>.com $600.00 .net $2,00 .org $6,00</div>'
    const p = parseGandiPage(gandiPage({ tld: 'im', extraNoise: noise }), 'im')
    assert.equal(p?.register, 20, '应取 Registration 标签下的价格，而非其他扩展名')
    assert.equal(p?.renew, 39.98)
  })

  test('缺少价格表时返回 null', () => {
    assert.equal(parseGandiPage('<html><body><p>Not found</p></body></html>', 'im'), null)
  })

  test('缺少 Registration 标签时返回 null，不猜测', () => {
    const html = '<html><body><h2>.im domain prices</h2><span>Renewal $39.98</span></body></html>'
    assert.equal(parseGandiPage(html, 'im'), null)
  })

  test('Registration 为 0 时视为无有效价格', () => {
    const p = parseGandiPage(gandiPage({ tld: 'im', registration: '$0.00' }), 'im')
    assert.equal(p, null)
  })

  test('元信息正确', () => {
    const p = parseGandiPage(gandiPage({ tld: 'im' }), 'im', '2026-01-01T00:00:00.000Z')
    assert.equal(p?.tld, 'im')
    assert.equal(p?.registrar, 'gandi')
    assert.equal(p?.registrarName, 'Gandi')
    assert.equal(p?.currency, 'USD')
    assert.equal(p?.source, 'crawled')
    assert.equal(p?.fetchedAt, '2026-01-01T00:00:00.000Z')
    assert.equal(p?.onSale, false)
  })

  test('regularRegister 与注册价一致（该页不区分促销）', () => {
    const p = parseGandiPage(gandiPage({ tld: 'im' }), 'im')
    assert.equal(p?.regularRegister, p?.register)
  })

  test('script 与 style 中的数字不污染解析', () => {
    const html = gandiPage({ tld: 'im' })
      .replace('</body>', '<script>var price = 999;</script><style>.x{width:123px}</style></body>')
    const p = parseGandiPage(html, 'im')
    assert.equal(p?.register, 20)
  })
})

describe('Gandi 抓取源', () => {
  // 抓取源默认覆盖 68 个后缀，测试里必须限定范围，
  // 否则用例会真的发 68 次请求（含 200ms 间隔，单例超 10 秒）
  const twoTlds = { tlds: ['al', 'im'], delayMs: 0 }

  test('HTTP 错误被记录而非静默跳过', async () => {
    const real = globalThis.fetch
    globalThis.fetch = (async () => new Response('', { status: 403 })) as typeof fetch
    try {
      const src = new GandiTldSource()
      await assert.rejects(() => src.fetchAll(twoTlds), /全部后缀抓取失败/)
      assert.equal(src.lastErrors.length, 2, '两个后缀都应记录失败')
      assert.match(src.lastErrors[0].message, /HTTP 403/)
    } finally {
      globalThis.fetch = real
    }
  })

  test('全部失败时抛错，不返回空列表', async () => {
    const real = globalThis.fetch
    globalThis.fetch = (async () => new Response('<html>no prices</html>', { status: 200 })) as typeof fetch
    try {
      await assert.rejects(() => new GandiTldSource().fetchAll(twoTlds), /全部后缀抓取失败/)
    } finally {
      globalThis.fetch = real
    }
  })

  test('部分成功时返回成功项，失败项记入 lastErrors', async () => {
    const real = globalThis.fetch
    globalThis.fetch = (async (url: any) => {
      if (String(url).endsWith('/im')) {
        return new Response(gandiPage({ tld: 'im' }), { status: 200 })
      }
      return new Response('', { status: 500 })
    }) as typeof fetch
    try {
      const src = new GandiTldSource()
      const out = await src.fetchAll(twoTlds)
      assert.equal(out.length, 1)
      assert.equal(out[0].tld, 'im')
      assert.equal(src.lastErrors.length, 1)
      assert.equal(src.lastErrors[0].tld, 'al')
    } finally {
      globalThis.fetch = real
    }
  })

  test('tlds 参数限定抓取范围', async () => {
    const real = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => { calls++; return new Response(gandiPage({ tld: 'im' }), { status: 200 }) }) as typeof fetch
    try {
      await new GandiTldSource().fetchAll({ tlds: ['im'], delayMs: 0 })
      assert.equal(calls, 1, '只应请求一次')
    } finally {
      globalThis.fetch = real
    }
  })

  test('默认抓取清单覆盖 .al / .im / .gg / .to 等 Porkbun 缺口后缀', async () => {
    const real = globalThis.fetch
    const asked: string[] = []
    globalThis.fetch = (async (url: any) => {
      asked.push(String(url).split('/').pop()!)
      return new Response(gandiPage({ tld: 'x' }), { status: 200 })
    }) as typeof fetch
    try {
      await new GandiTldSource().fetchAll({ delayMs: 0 })
      for (const t of ['al', 'im', 'gg', 'je', 'to', 'cx']) {
        assert.ok(asked.includes(t), `默认清单应包含 .${t}`)
      }
      assert.ok(asked.length >= 50, `默认清单应有足够覆盖，实际 ${asked.length}`)
    } finally {
      globalThis.fetch = real
    }
  })

  test('超时被记录为失败', async () => {
    const real = globalThis.fetch
    globalThis.fetch = ((_u: any, init: any) => new Promise((_r, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))
    })) as typeof fetch
    try {
      await assert.rejects(() => new GandiTldSource().fetchAll({ timeoutMs: 50, tlds: ['im'], delayMs: 0 }))
    } finally {
      globalThis.fetch = real
    }
  })
})
