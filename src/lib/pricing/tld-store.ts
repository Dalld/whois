/**
 * 文件：src/lib/pricing/tld-store.ts
 * 用途：后缀价格缓存（node:sqlite）
 *
 * ## 为什么缓存是必需的，而不是优化
 *
 * 后缀价目表是**整表抓取**：一次请求拿到 600 条，覆盖全部后缀。
 * 因此绝不能按「单个后缀」去触发抓取——那意味着同一份数据被反复下载。
 * 正确做法是：整表入库，查询时只读本地。
 *
 * 这也让当前查询零外连：用户查 `.cx` 时，数据早已在库里。
 *
 * ## 与域名级缓存的区别
 *
 * 域名级（`store.ts`）键是 `(registrar, domain)`，TTL 12 小时。
 * 后缀级（本文件）键是 `(source, tld)`，整表刷新，
 * 数据源维度的新鲜度由 `sources` 表统一记录。
 */

import { DatabaseSync } from 'node:sqlite'
import type { TldPrice } from './tld-types'

/** 整表默认有效期：1 天。后缀价变动慢，但促销会变 */
export const DEFAULT_TLD_TTL_MS = 24 * 60 * 60 * 1000

export interface TldStoreOptions {
  path: string
  ttlMs?: number
}

export interface SourceStatus {
  source: string
  tldCount: number
  fetchedAt: string
  ageMs: number
  stale: boolean
}

export class TldPriceStore {
  private db: DatabaseSync
  private ttlMs: number

  constructor(options: TldStoreOptions) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TLD_TTL_MS
    this.db = new DatabaseSync(options.path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tld_prices (
        source       TEXT NOT NULL,
        tld          TEXT NOT NULL,
        registrar    TEXT NOT NULL,
        registrar_name TEXT NOT NULL,
        register     REAL,
        renew        REAL,
        transfer     REAL,
        regular_register REAL,
        on_sale      INTEGER NOT NULL DEFAULT 0,
        currency     TEXT NOT NULL DEFAULT 'USD',
        website      TEXT NOT NULL DEFAULT '',
        fetched_at   TEXT NOT NULL,
        PRIMARY KEY (source, tld)
      );
      CREATE INDEX IF NOT EXISTS idx_tld_prices_tld ON tld_prices (tld);

      CREATE TABLE IF NOT EXISTS tld_sources (
        source     TEXT PRIMARY KEY,
        fetched_at TEXT NOT NULL,
        tld_count  INTEGER NOT NULL
      );
    `)
  }

  /**
   * 整表写入某个数据源的全部后缀价。
   * 在同一事务内先删后插：数据源下架的后缀也应随之消失，
   * 否则会留下永远不会更新的僵尸条目。
   *
   * 主键为 (source, tld)，同一数据源内一个后缀只能有一条记录。
   * 若入参含重复 TLD（抓取页面出现重复区块时可能发生），
   * 保留**续费价更低**的一条，而不是让整批写入失败——
   * 一个重复项不应导致整个数据源刷新失败。
   */
  saveAll(source: string, prices: TldPrice[], fetchedAt = new Date().toISOString()): number {
    if (prices.length === 0) return 0

    const deduped = dedupeByTld(prices)

    const insert = this.db.prepare(`
      INSERT INTO tld_prices
        (source, tld, registrar, registrar_name, register, renew, transfer,
         regular_register, on_sale, currency, website, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const clear = this.db.prepare('DELETE FROM tld_prices WHERE source = ?')
    const stamp = this.db.prepare(`
      INSERT INTO tld_sources (source, fetched_at, tld_count) VALUES (?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET fetched_at = excluded.fetched_at,
        tld_count = excluded.tld_count
    `)

    this.db.exec('BEGIN')
    try {
      clear.run(source)
      for (const p of deduped) {
        insert.run(
          source,
          p.tld,
          p.registrar,
          p.registrarName,
          p.register ?? null,
          p.renew ?? null,
          p.transfer ?? null,
          p.regularRegister ?? null,
          p.onSale ? 1 : 0,
          p.currency,
          p.website,
          p.fetchedAt || fetchedAt,
        )
      }
      stamp.run(source, fetchedAt, deduped.length)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return deduped.length
  }

  /** 查某个后缀在各数据源的报价 */
  getByTld(tld: string): TldPrice[] {
    const rows = this.db.prepare(
      'SELECT * FROM tld_prices WHERE tld = ? ORDER BY renew IS NULL, renew ASC'
    ).all(tld.toLowerCase().replace(/^\.+/, '')) as any[]
    return rows.map(toTldPrice)
  }

  /**
   * 按候选后缀**依次尝试**，返回首个命中的后缀及其报价。
   *
   * 用于 `feng.cx` 这类输入：先试 `co.uk` 形式的长后缀，
   * 再退到 `uk`。返回命中的后缀本身，便于界面显示
   * 「按 .co.uk 计价」而不是让用户猜。
   */
  findTld(candidates: string[]): { tld: string; prices: TldPrice[] } | null {
    for (const c of candidates) {
      const prices = this.getByTld(c)
      if (prices.length > 0) return { tld: c.toLowerCase(), prices }
    }
    return null
  }

  /** 各数据源的新鲜度 */
  sources(): SourceStatus[] {
    const rows = this.db.prepare(
      'SELECT source, fetched_at, tld_count FROM tld_sources ORDER BY source'
    ).all() as any[]
    const now = Date.now()
    return rows.map(r => {
      const age = now - new Date(r.fetched_at).getTime()
      return {
        source: String(r.source),
        tldCount: Number(r.tld_count),
        fetchedAt: String(r.fetched_at),
        ageMs: age,
        stale: age >= this.ttlMs,
      }
    })
  }

  /** 需要刷新的数据源；返回空表示全部新鲜 */
  staleSources(known: string[]): string[] {
    const fresh = new Set(
      this.sources().filter(s => !s.stale).map(s => s.source)
    )
    return known.filter(id => !fresh.has(id))
  }

  stats(): { tlds: number; prices: number; sources: number } {
    const tlds = this.db.prepare('SELECT COUNT(DISTINCT tld) AS n FROM tld_prices').get() as any
    const prices = this.db.prepare('SELECT COUNT(*) AS n FROM tld_prices').get() as any
    const sources = this.db.prepare('SELECT COUNT(*) AS n FROM tld_sources').get() as any
    return {
      tlds: Number(tlds?.n ?? 0),
      prices: Number(prices?.n ?? 0),
      sources: Number(sources?.n ?? 0),
    }
  }

  close() {
    this.db.close()
  }
}

/**
 * 同一数据源内按 TLD 去重。
 *
 * 主键是 (source, tld)，重复项会让整批写入失败。
 * 抓取页面出现重复区块时确实可能产生重复 TLD，
 * 此时保留续费价更低的一条——一个重复项不该让整个数据源刷新失败。
 */
function dedupeByTld(prices: TldPrice[]): TldPrice[] {
  const best = new Map<string, TldPrice>()
  for (const p of prices) {
    const key = p.tld
    const prev = best.get(key)
    if (!prev) {
      best.set(key, p)
      continue
    }
    const prevKey = prev.renew ?? prev.register ?? Number.POSITIVE_INFINITY
    const nextKey = p.renew ?? p.register ?? Number.POSITIVE_INFINITY
    if (nextKey < prevKey) best.set(key, p)
  }
  return [...best.values()]
}

function toTldPrice(r: any): TldPrice {  return {
    tld: String(r.tld),
    registrar: String(r.registrar),
    registrarName: String(r.registrar_name),
    register: r.register === null ? null : Number(r.register),
    renew: r.renew === null ? null : Number(r.renew),
    transfer: r.transfer === null ? null : Number(r.transfer),
    regularRegister: r.regular_register === null ? null : Number(r.regular_register),
    onSale: Number(r.on_sale) === 1,
    currency: 'USD',
    // 存的是抓取来源；读出时统一标记为 crawled
    source: 'crawled',
    website: String(r.website),
    fetchedAt: String(r.fetched_at),
  }
}
