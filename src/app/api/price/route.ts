import { NextRequest, NextResponse } from 'next/server'
import { TldPriceStore } from '@/lib/pricing/tld-store'
import { compareTld } from '@/lib/pricing/tld-refresh'
import { buildTldSources } from '@/lib/pricing/tld-registry'
import { tldCandidates, normalizeTld, sortKey } from '@/lib/pricing/tld-types'

export const runtime = 'nodejs'

/**
 * 后缀比价接口。
 *
 * ## 为什么改成后缀级
 *
 * 原实现走「域名级」：逐域名调各家注册商 API，受批量上限与限流约束，
 * 且只能覆盖已配置凭证的少数几家。
 *
 * 现在改走「后缀级」：数据来自 Porkbun 的**官方公开价目接口**
 * （`/api/json/v3/pricing/get`，无需认证，一次返回 910 个后缀），
 * 由 `scripts/tld-prices.ts refresh` 定期整表抓取入库。
 *
 * 因此本接口**只读本地 SQLite，零外连**：
 * 用户查询不会打到任何注册商，也就不会被限流。
 *
 * ## 与域名级的取舍
 *
 * 后缀价是**非溢价域名的挂牌价**。具体某个域名是否溢价、是否已被注册，
 * 由用户在注册商页面自行确认。本接口只回答
 * 「这个后缀什么价位、哪家最便宜」，不承诺最终结算价。
 */

/** 数据库路径与 CLI 保持一致，便于定时任务复用同一份数据 */
const DB_PATH = process.env.TLD_DB_PATH ?? '.tld-prices.db'

/**
 * 复用单个连接：node:sqlite 的打开成本不低，
 * 每次请求新建会拖慢响应，且 SQLite 允许多次读取共享连接。
 */
let store: TldPriceStore | null = null
function getStore(): TldPriceStore {
  if (!store) store = new TldPriceStore({ path: DB_PATH })
  return store
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const input = (searchParams.get('domain') || searchParams.get('tld') || '').trim().toLowerCase()

  if (!input) {
    return NextResponse.json({ success: false, error: '缺少 domain 或 tld 参数', data: null }, { status: 400 })
  }
  // 只允许域名/后缀字符，避免把任意输入丢进查询
  if (!/^[a-z0-9.-]+$/.test(input) || input.length > 253) {
    return NextResponse.json({ success: false, error: '无效的域名或后缀', data: null }, { status: 400 })
  }

  try {
    const db = getStore()
    const sources = buildTldSources()

    // 域名 → 候选后缀（最长优先）；纯后缀输入直接使用
    const candidates = input.includes('.') && !input.startsWith('.')
      ? tldCandidates(input)
      : [normalizeTld(input)]

    const result = compareTld(db, input, { adapters: sources })

    // 缓存尚未初始化时给出可操作的提示，而不是静默返回空
    if (result.quotes.length === 0) {
      const hasAny = db.stats().tlds > 0
      return NextResponse.json({
        success: true,
        data: {
          ...result,
          candidates,
          initialized: hasAny,
          hint: hasAny
            ? '该后缀不在数据源覆盖范围内'
            : '本地尚无后缀价数据，请先运行 scripts/tld-prices.ts refresh',
        },
      })
    }

    const best = result.quotes[0]
    const bestKey = sortKey(best)

    return NextResponse.json({
      success: true,
      data: {
        tld: result.tld,
        candidates,
        initialized: true,
        quotes: result.quotes.map(q => ({
          registrar: q.registrar,
          registrarName: q.registrarName,
          register: q.register,
          renew: q.renew,
          transfer: q.transfer,
          regularRegister: q.regularRegister,
          onSale: q.onSale,
          currency: q.currency,
          website: q.website,
          // 相对最低价的差额，便于前端直接展示
          diff: (() => {
            const k = sortKey(q)
            return Number.isFinite(k) && Number.isFinite(bestKey) && q !== best ? k - bestKey : null
          })(),
        })),
        cheapest: {
          registrar: best.registrar,
          registrarName: best.registrarName,
          register: best.register,
          renew: best.renew,
          website: best.website,
        },
        missing: result.missing,
        fetchedAt: result.fetchedAt,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '后缀比价查询失败'
    return NextResponse.json({ success: false, error: message, data: null }, { status: 500 })
  }
}
