/**
 * 文件：src/lib/pricing/store.ts
 * 用途：域名比价 —— 本地价格缓存
 *
 * 为什么必须缓存：
 * Porkbun 限流「10 秒内最多 10 次」，Cloudflare 的 Check 更是直连注册局。
 * 用户每次查询都实时打各家的 API 会立刻撞限流，因此架构必须是
 * 「定时预拉取 → 落库 → 查询命中缓存」，实时请求只作为冷门后缀的补充。
 *
 * 存储选型：node:sqlite（Node 22+ 内置）
 * 不引入 better-sqlite3 等原生模块，避免 Windows 上的编译工具链依赖，
 * 也省去 one-click 部署时的二进制分发问题。
 *
 * 表结构说明：
 * - quotes：以 (registrar, domain) 为键，存单个域名的报价快照
 * - tld_prices：以 (registrar, tld) 为键，存后缀级价格表
 *   后缀级数据一次拉取可服务大量域名查询，命中率远高于逐域名缓存
 */

import { DatabaseSync } from 'node:sqlite'
import type { PriceQuote, RegistrarQuote, QuoteSource } from './types'

/** 默认缓存有效期：12 小时。价格变动不频繁，过期后由刷新任务更新 */
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000

export interface StoredQuote {
  quote: RegistrarQuote
  /** 写入时间（ISO 8601） */
  storedAt: string
  /** 本条数据的过期时间（ISO 8601） */
  expiresAt: string
  /** 是否已过期 */
  expired: boolean
}

export interface StoreOptions {
  /** 数据库文件路径；传 ':memory:' 用于测试 */
  path: string
  /** 缓存有效期（毫秒） */
  ttlMs?: number
}

interface QuoteRow {
  registrar: string
  registrar_name: string
  domain: string
  tld: string
  available: number
  premium: number
  currency: string
  register_price: number | null
  register_regular: number | null
  register_on_sale: number | null
  renew_price: number | null
  renew_regular: number | null
  renew_on_sale: number | null
  transfer_price: number | null
  transfer_regular: number | null
  transfer_on_sale: number | null
  min_duration: number | null
  source: string
  fetched_at: string
  stored_at: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quotes (
  registrar         TEXT NOT NULL,
  registrar_name    TEXT NOT NULL,
  domain            TEXT NOT NULL,
  tld               TEXT NOT NULL,
  available         INTEGER NOT NULL,
  premium           INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'USD',
  register_price    REAL,
  register_regular  REAL,
  register_on_sale  INTEGER,
  renew_price       REAL,
  renew_regular     REAL,
  renew_on_sale     INTEGER,
  transfer_price    REAL,
  transfer_regular  REAL,
  transfer_on_sale  INTEGER,
  min_duration      INTEGER,
  source            TEXT NOT NULL,
  fetched_at        TEXT NOT NULL,
  stored_at         TEXT NOT NULL,
  PRIMARY KEY (registrar, domain)
);

CREATE INDEX IF NOT EXISTS idx_quotes_domain ON quotes (domain);
CREATE INDEX IF NOT EXISTS idx_quotes_tld    ON quotes (tld);

-- 价格变动历史：用于「涨价/降价」提示，也便于排查数据异常
CREATE TABLE IF NOT EXISTS price_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  registrar      TEXT NOT NULL,
  domain         TEXT NOT NULL,
  renew_price    REAL,
  register_price REAL,
  observed_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_domain ON price_history (domain, observed_at DESC);
`

export class PriceStore {
  private readonly db: DatabaseSync
  readonly ttlMs: number

  constructor(options: StoreOptions) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.db = new DatabaseSync(options.path)
    // WAL 提升并发读性能；内存库会回落到 memory 模式，不影响测试
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
  }

  /** 写入或更新一条报价。已存在则覆盖，并记录价格变动 */
  save(quote: RegistrarQuote): void {
    const now = new Date().toISOString()
    const prev = this.get(quote.registrar, quote.domain)

    this.db.prepare(`
      INSERT INTO quotes (
        registrar, registrar_name, domain, tld, available, premium, currency,
        register_price, register_regular, register_on_sale,
        renew_price, renew_regular, renew_on_sale,
        transfer_price, transfer_regular, transfer_on_sale,
        min_duration, source, fetched_at, stored_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(registrar, domain) DO UPDATE SET
        registrar_name   = excluded.registrar_name,
        tld              = excluded.tld,
        available        = excluded.available,
        premium          = excluded.premium,
        currency         = excluded.currency,
        register_price   = excluded.register_price,
        register_regular = excluded.register_regular,
        register_on_sale = excluded.register_on_sale,
        renew_price      = excluded.renew_price,
        renew_regular    = excluded.renew_regular,
        renew_on_sale    = excluded.renew_on_sale,
        transfer_price   = excluded.transfer_price,
        transfer_regular = excluded.transfer_regular,
        transfer_on_sale = excluded.transfer_on_sale,
        min_duration     = excluded.min_duration,
        source           = excluded.source,
        fetched_at       = excluded.fetched_at,
        stored_at        = excluded.stored_at
    `).run(
      quote.registrar, quote.registrarName, quote.domain, quote.tld,
      quote.available ? 1 : 0, quote.premium ? 1 : 0, quote.currency,
      quote.register?.price ?? null, quote.register?.regularPrice ?? null,
      quote.register ? (quote.register.onSale ? 1 : 0) : null,
      quote.renew?.price ?? null, quote.renew?.regularPrice ?? null,
      quote.renew ? (quote.renew.onSale ? 1 : 0) : null,
      quote.transfer?.price ?? null, quote.transfer?.regularPrice ?? null,
      quote.transfer ? (quote.transfer.onSale ? 1 : 0) : null,
      quote.minDuration, quote.source, quote.fetchedAt, now,
    )

    // 仅当价格发生变化时写历史，避免每次刷新都灌入重复行
    const prevRenew = prev?.quote.renew?.price ?? null
    const nextRenew = quote.renew?.price ?? null
    const prevReg = prev?.quote.register?.price ?? null
    const nextReg = quote.register?.price ?? null
    if (prev === null || prevRenew !== nextRenew || prevReg !== nextReg) {
      this.db.prepare(
        'INSERT INTO price_history (registrar, domain, renew_price, register_price, observed_at) VALUES (?,?,?,?,?)',
      ).run(quote.registrar, quote.domain, nextRenew, nextReg, now)
    }
  }

  /** 批量写入，单事务提交 */
  saveMany(quotes: RegistrarQuote[]): void {
    this.db.exec('BEGIN')
    try {
      for (const q of quotes) this.save(q)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 读取某注册商对某域名的缓存。
   * @param includeExpired 为 true 时忽略过期时间，返回陈旧数据
   */
  get(registrar: string, domain: string, includeExpired = false): StoredQuote | null {
    const row = this.db.prepare(
      'SELECT * FROM quotes WHERE registrar = ? AND domain = ?',
    ).get(registrar, domain.toLowerCase()) as QuoteRow | undefined
    if (!row) return null
    return this.toStored(row, includeExpired)
  }

  /** 读取某域名在所有注册商的缓存，按续费价升序 */
  getByDomain(domain: string, includeExpired = false): StoredQuote[] {
    const rows = this.db.prepare(
      'SELECT * FROM quotes WHERE domain = ? ORDER BY COALESCE(renew_price, register_price, 1e9) ASC, registrar ASC',
    ).all(domain.toLowerCase()) as unknown as QuoteRow[]
    return rows.map(r => this.toStored(r, includeExpired)).filter((s): s is StoredQuote => s !== null)
  }

  /** 列出已过期（或缺失）的域名，供刷新任务使用 */
  listStaleDomains(limit = 100): string[] {
    // 与 toStored 的过期判定保持一致：stored_at + ttl <= now 即过期。
    // ttlMs 为 0 时 cutoff 即当前时刻，用 <= 保证刚写入的数据也被视为过期。
    const cutoff = new Date(Date.now() - this.ttlMs).toISOString()
    const rows = this.db.prepare(
      'SELECT DISTINCT domain FROM quotes WHERE stored_at <= ? ORDER BY stored_at ASC LIMIT ?',
    ).all(cutoff, limit) as unknown as { domain: string }[]
    return rows.map(r => r.domain)
  }

  /** 最近一次写入时间；无数据时返回 null */
  lastUpdatedAt(registrar?: string): string | null {
    const row = registrar
      ? this.db.prepare('SELECT MAX(stored_at) AS t FROM quotes WHERE registrar = ?').get(registrar)
      : this.db.prepare('SELECT MAX(stored_at) AS t FROM quotes').get()
    const t = (row as { t: string | null } | undefined)?.t
    return t ?? null
  }

  /** 统计信息，用于诊断 */
  stats(): { quotes: number; domains: number; registrars: number; history: number } {
    const q = this.db.prepare('SELECT COUNT(*) AS c, COUNT(DISTINCT domain) AS d, COUNT(DISTINCT registrar) AS r FROM quotes').get() as { c: number; d: number; r: number }
    const h = this.db.prepare('SELECT COUNT(*) AS c FROM price_history').get() as { c: number }
    return { quotes: q.c, domains: q.d, registrars: q.r, history: h.c }
  }

  close(): void {
    this.db.close()
  }

  /** 行 → StoredQuote */
  private toStored(row: QuoteRow, includeExpired: boolean): StoredQuote | null {
    const expiresAt = new Date(new Date(row.stored_at).getTime() + this.ttlMs).toISOString()
    // 用 >= 而非 >：写入与读取可能落在同一毫秒，此时 ttl 已耗尽，应视为过期。
    // 若用 >，ttlMs=0 的数据会被误判为新鲜，刷新任务将永远跳过它。
    const expired = Date.now() >= new Date(expiresAt).getTime()
    if (expired && !includeExpired) return null

    const price = (
      p: number | null, regular: number | null, onSale: number | null,
    ): PriceQuote | null => {
      if (p === null && regular === null) return null
      const actual = p ?? regular!
      const reg = regular ?? p!
      return { price: actual, regularPrice: reg, onSale: onSale === 1 }
    }

    return {
      quote: {
        registrar: row.registrar,
        registrarName: row.registrar_name,
        domain: row.domain,
        tld: row.tld,
        available: row.available === 1,
        premium: row.premium === 1,
        currency: 'USD',
        register: price(row.register_price, row.register_regular, row.register_on_sale),
        renew: price(row.renew_price, row.renew_regular, row.renew_on_sale),
        transfer: price(row.transfer_price, row.transfer_regular, row.transfer_on_sale),
        minDuration: row.min_duration,
        fetchedAt: row.fetched_at,
        source: row.source as QuoteSource,
      },
      storedAt: row.stored_at,
      expiresAt,
      expired,
    }
  }
}
