import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TldPriceStore } from '../src/lib/pricing/tld-store'
import { refreshTldSources, refreshStaleTldSources, compareTld, cheapestFor } from '../src/lib/pricing/tld-refresh'
import type { TldPrice, TldPriceSourceAdapter } from '../src/lib/pricing/tld-types'

let dir: string
let store: TldPriceStore

const mk = (over: Partial<TldPrice> & { tld: string; registrar: string }): TldPrice => ({
  registrarName: over.registrar,
  register: null,
  renew: null,
  transfer: null,
  regularRegister: null,
  onSale: false,
  currency: 'USD',
  source: 'crawled',
  website: `https://${over.registrar}.example`,
  fetchedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

function fakeSource(id: string, prices: TldPrice[], opts: { fail?: string } = {}): TldPriceSourceAdapter {
  return {
    id,
    name: id,
    website: `https://${id}.example`,
    async fetchAll() {
      if (opts.fail) throw new Error(opts.fail)
      return prices
    },
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tld-store-'))
  store = new TldPriceStore({ path: join(dir, 'test.db') })
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('后缀价格存储', () => {
  test('整表写入与读取', () => {
    store.saveAll('porkbun', [mk({ tld: 'cx', registrar: 'porkbun', register: 16.53, renew: 16.75 })])
    const got = store.getByTld('cx')
    assert.equal(got.length, 1)
    assert.equal(got[0].register, 16.53)
    assert.equal(got[0].renew, 16.75)
  })

  test('查询不区分大小写与前导点', () => {
    store.saveAll('porkbun', [mk({ tld: 'cx', registrar: 'porkbun', renew: 16.75 })])
    assert.equal(store.getByTld('CX').length, 1)
    assert.equal(store.getByTld('.cx').length, 1)
    assert.equal(store.getByTld('..CX').length, 1)
  })

  test('重新写入同一数据源会替换而非累加', () => {
    store.saveAll('porkbun', [
      mk({ tld: 'cx', registrar: 'porkbun', renew: 16.75 }),
      mk({ tld: 'com', registrar: 'porkbun', renew: 11.08 }),
    ])
    // 第二次只给 cx —— com 应从该数据源下架
    store.saveAll('porkbun', [mk({ tld: 'cx', registrar: 'porkbun', renew: 15.0 })])
    assert.equal(store.getByTld('com').length, 0, '已下架的后缀不应残留')
    assert.equal(store.getByTld('cx')[0].renew, 15.0)
  })

  test('不同数据源互不覆盖', () => {
    store.saveAll('porkbun', [mk({ tld: 'cx', registrar: 'porkbun', renew: 16.75 })])
    store.saveAll('namecheap', [mk({ tld: 'cx', registrar: 'namecheap', renew: 14.2 })])
    const got = store.getByTld('cx')
    assert.equal(got.length, 2)
    // 按续费价升序
    assert.equal(got[0].registrar, 'namecheap')
  })

  test('null 价格可存取，不变成 0', () => {
    store.saveAll('porkbun', [mk({ tld: 'cx', registrar: 'porkbun', register: null, renew: 16.75, transfer: null })])
    const got = store.getByTld('cx')[0]
    assert.equal(got.register, null)
    assert.equal(got.transfer, null)
    assert.notEqual(got.register, 0)
  })

  test('促销标记与标准价可以往返', () => {
    store.saveAll('porkbun', [mk({ tld: 'xyz', registrar: 'porkbun', register: 2.04, regularRegister: 14.21, renew: 14.21, onSale: true })])
    const got = store.getByTld('xyz')[0]
    assert.equal(got.onSale, true)
    assert.equal(got.register, 2.04)
    assert.equal(got.regularRegister, 14.21)
  })

  test('空数组不写入，也不清空既有数据', () => {
    store.saveAll('porkbun', [mk({ tld: 'cx', registrar: 'porkbun', renew: 16.75 })])
    const n = store.saveAll('porkbun', [])
    assert.equal(n, 0)
    assert.equal(store.getByTld('cx').length, 1, '空写入不应清空既有数据')
  })

  test('findTld 按候选顺序命中，最长优先', () => {
    store.saveAll('porkbun', [
      mk({ tld: 'co.uk', registrar: 'porkbun', renew: 5.66 }),
      mk({ tld: 'uk', registrar: 'porkbun', renew: 9.99 }),
    ])
    const hit = store.findTld(['co.uk', 'uk'])
    assert.equal(hit?.tld, 'co.uk')
    assert.equal(hit?.prices[0].renew, 5.66)
  })

  test('findTld 长后缀缺失时回落到短后缀', () => {
    store.saveAll('porkbun', [mk({ tld: 'uk', registrar: 'porkbun', renew: 9.99 })])
    assert.equal(store.findTld(['co.uk', 'uk'])?.tld, 'uk')
  })

  test('findTld 全部缺失时返回 null', () => {
    assert.equal(store.findTld(['nonexistent']), null)
  })

  test('stats 统计去重后的后缀数', () => {
    store.saveAll('a', [mk({ tld: 'cx', registrar: 'a' }), mk({ tld: 'com', registrar: 'a' })])
    store.saveAll('b', [mk({ tld: 'cx', registrar: 'b' })])
    const s = store.stats()
    assert.equal(s.tlds, 2, '去重后应有 cx 与 com 两个后缀')
    assert.equal(s.prices, 3)
    assert.equal(s.sources, 2)
  })
})

describe('数据源新鲜度', () => {
  test('刚写入的数据源是新鲜的', () => {
    store.saveAll('porkbun', [mk({ tld: 'cx', registrar: 'porkbun' })])
    const s = store.sources()
    assert.equal(s.length, 1)
    assert.equal(s[0].stale, false)
    assert.equal(s[0].tldCount, 1)
  })

  test('超过 TTL 判定为过期', () => {
    const old = new TldPriceStore({ path: join(dir, 'ttl.db'), ttlMs: 0 })
    old.saveAll('porkbun', [mk({ tld: 'cx', registrar: 'porkbun' })])
    assert.equal(old.sources()[0].stale, true, 'ttlMs=0 时写入即过期')
    old.close()
  })

  test('staleSources 只返回过期的，未记录的也算缺失', () => {
    store.saveAll('porkbun', [mk({ tld: 'cx', registrar: 'porkbun' })])
    // namecheap 从未写入 → 应视为需要刷新
    assert.deepEqual(store.staleSources(['porkbun', 'namecheap']), ['namecheap'])
  })
})

describe('整表刷新', () => {
  test('刷新多个数据源并写入', async () => {
    const a = fakeSource('a', [mk({ tld: 'cx', registrar: 'a', renew: 10 })])
    const b = fakeSource('b', [mk({ tld: 'cx', registrar: 'b', renew: 20 })])
    const r = await refreshTldSources([a, b], store)
    assert.equal(r.refreshed.length, 2)
    assert.equal(r.errors.length, 0)
    assert.equal(store.getByTld('cx').length, 2)
  })

  test('单个数据源失败不影响其他', async () => {
    const ok = fakeSource('ok', [mk({ tld: 'cx', registrar: 'ok', renew: 10 })])
    const bad = fakeSource('bad', [], { fail: '页面改版' })
    const r = await refreshTldSources([ok, bad], store)
    assert.equal(r.refreshed.length, 1)
    assert.equal(r.errors.length, 1)
    assert.match(r.errors[0].message, /页面改版/)
    assert.equal(store.getByTld('cx').length, 1, '成功的数据源应已入库')
  })

  test('失败时保留旧数据，不清空', async () => {
    await refreshTldSources([fakeSource('a', [mk({ tld: 'cx', registrar: 'a', renew: 10 })])], store)
    await refreshTldSources([fakeSource('a', [], { fail: '临时故障' })], store)
    assert.equal(store.getByTld('cx').length, 1, '故障不应清掉已有数据')
  })

  test('only 参数限定刷新范围', async () => {
    const a = fakeSource('a', [mk({ tld: 'cx', registrar: 'a' })])
    const b = fakeSource('b', [mk({ tld: 'com', registrar: 'b' })])
    const r = await refreshTldSources([a, b], store, { only: ['a'] })
    assert.equal(r.refreshed.length, 1)
    assert.equal(r.refreshed[0].source, 'a')
    assert.equal(store.getByTld('com').length, 0)
  })

  test('refreshStaleTldSources 全部新鲜时不发请求', async () => {
    let calls = 0
    const adapter: TldPriceSourceAdapter = {
      id: 'a', name: 'a', website: '',
      async fetchAll() { calls++; return [mk({ tld: 'cx', registrar: 'a' })] },
    }
    await refreshTldSources([adapter], store)
    assert.equal(calls, 1)
    const r = await refreshStaleTldSources([adapter], store)
    assert.equal(calls, 1, '新鲜时不应再次抓取')
    assert.equal(r.refreshed.length, 0)
  })

  test('onProgress 上报开始与完成', async () => {
    const events: string[] = []
    await refreshTldSources([fakeSource('a', [mk({ tld: 'cx', registrar: 'a' })])], store, {
      onProgress: e => events.push(`${e.type}:${e.source}`),
    })
    assert.deepEqual(events, ['start:a', 'done:a'])
  })
})

describe('后缀比价', () => {
  beforeEach(() => {
    store.saveAll('porkbun', [
      mk({ tld: 'cx', registrar: 'porkbun', registrarName: 'Porkbun', register: 16.53, renew: 16.75 }),
      mk({ tld: 'com', registrar: 'porkbun', registrarName: 'Porkbun', register: 11.08, renew: 11.08 }),
    ])
    store.saveAll('cheap', [
      mk({ tld: 'cx', registrar: 'cheap', registrarName: 'CheapCo', register: 9.0, renew: 12.0 }),
    ])
  })

  test('按续费价排序，最便宜的排首位', () => {
    const r = compareTld(store, 'cx')
    assert.equal(r.tld, 'cx')
    assert.equal(r.quotes[0].registrar, 'cheap', '续费 $12 应排在 $16.75 之前')
    assert.equal(r.cheapest?.registrar, 'cheap')
  })

  test('接受完整域名输入', () => {
    assert.equal(compareTld(store, 'feng.cx').tld, 'cx')
    assert.equal(compareTld(store, 'FENG.CX').tld, 'cx')
  })

  test('接受带点的后缀输入', () => {
    assert.equal(compareTld(store, '.cx').tld, 'cx')
  })

  test('未收录的后缀返回空结果而非报错', () => {
    const r = compareTld(store, 'nonexistent')
    assert.equal(r.quotes.length, 0)
    assert.equal(r.cheapest, null)
  })

  test('missing 列出未提供该后缀的数据源', () => {
    const adapters = [fakeSource('porkbun', []), fakeSource('cheap', []), fakeSource('third', [])]
    const r = compareTld(store, 'cx', { adapters })
    assert.deepEqual(r.missing, ['third'])
  })

  test('同价时按注册商名稳定排序', () => {
    store.saveAll('z', [mk({ tld: 'cx', registrar: 'z', registrarName: 'Zeta', renew: 12.0 })])
    store.saveAll('a', [mk({ tld: 'cx', registrar: 'a', registrarName: 'Alpha', renew: 12.0 })])
    const r = compareTld(store, 'cx')
    const tied = r.quotes.filter(q => q.renew === 12.0).map(q => q.registrarName)
    assert.deepEqual(tied, ['Alpha', 'CheapCo', 'Zeta'].filter(n => tied.includes(n)))
  })

  test('cheapestFor 在同后缀中取最低续费价', () => {
    const prices = [
      mk({ tld: 'cx', registrar: 'a', renew: 30 }),
      mk({ tld: 'cx', registrar: 'b', renew: 10 }),
      mk({ tld: 'com', registrar: 'c', renew: 1 }),
    ]
    assert.equal(cheapestFor(prices, 'cx')?.registrar, 'b')
    assert.equal(cheapestFor(prices, '.cx')?.registrar, 'b')
    assert.equal(cheapestFor(prices, 'net'), null)
  })

  test('续费价缺失时按注册价排，皆无排最后', () => {
    store.saveAll('x', [
      mk({ tld: 'cx', registrar: 'x', registrarName: 'NoPrice', register: null, renew: null }),
    ])
    // 同一数据源内一个 TLD 只能有一条，故分数据源写入
    store.saveAll('y', [
      mk({ tld: 'cx', registrar: 'y', registrarName: 'RegOnly', register: 5, renew: null }),
    ])
    const r = compareTld(store, 'cx')
    const order = r.quotes.map(q => q.registrarName)
    assert.ok(order.indexOf('RegOnly') < order.indexOf('NoPrice'), '有注册价的应排在无价之前')
  })

  test('同一数据源内重复 TLD 保留续费价更低者，且不抛错', () => {
    // 用独立后缀，避免与其他用例的种子数据混淆
    const saved = store.saveAll('dedupe-src', [
      mk({ tld: 'dedupe.test', registrar: 'porkbun', renew: 20 }),
      mk({ tld: 'dedupe.test', registrar: 'porkbun', renew: 15 }),
      mk({ tld: 'dedupe.test', registrar: 'porkbun', renew: 18 }),
    ])
    assert.equal(saved, 1, '应去重为一条')
    const got = store.getByTld('dedupe.test')
    assert.equal(got.length, 1)
    assert.equal(got[0].renew, 15)
  })

  test('重复项中一方无价时保留有价的一方', () => {
    store.saveAll('dedupe-src2', [
      mk({ tld: 'dedupe2.test', registrar: 'porkbun', register: null, renew: null }),
      mk({ tld: 'dedupe2.test', registrar: 'porkbun', renew: 16.75 }),
    ])
    const got = store.getByTld('dedupe2.test')
    assert.equal(got.length, 1)
    assert.equal(got[0].renew, 16.75)
  })
})
