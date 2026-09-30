/**
 * 文件：src/components/price-compare.tsx
 * 用途：域名比价区块
 *
 * 设计目标：让用户**一眼**看出「哪家便宜、便宜多少、是不是首年促销陷阱」，
 * 而不是甩一张需要逐行比对的表格。
 *
 * 三个关键取舍：
 * 1. 主排序用**续费价**。首年价常被用来引流（$0.99 首年、$29 续费），
 *    按首年价排会得出误导性的「最便宜」。续费价才是长期真实成本。
 * 2. 促销价**同时显示标准价**并加删除线，让用户看清优惠幅度与到期后的价格。
 * 3. 溢价域名单独提示。同一后缀下 $10 与 $1250 不具可比性，
 *    不说明会误导用户。
 */

"use client"

import { useEffect, useState } from "react"
import { Loader2, TrendingDown, AlertTriangle, Info } from "lucide-react"
import { cn } from "@/lib/utils"

export interface PriceQuoteItem {
  price: number
  regularPrice: number
  onSale: boolean
}

export interface RegistrarQuoteItem {
  registrar: string
  registrarName: string
  domain: string
  tld: string
  available: boolean
  premium: boolean
  currency: string
  register: PriceQuoteItem | null
  renew: PriceQuoteItem | null
  transfer: PriceQuoteItem | null
  source: string
}

export interface PriceComparisonData {
  domain: string
  quotes: RegistrarQuoteItem[]
  cheapest: RegistrarQuoteItem | null
  errors: { registrar: string; message: string }[]
  skipped: string[]
  queriedAt: string
}

/** 注册商官网，用于「去注册」链接 */
const REGISTRAR_URLS: Record<string, string> = {
  cloudflare: 'https://dash.cloudflare.com/',
  porkbun: 'https://porkbun.com/',
  spaceship: 'https://www.spaceship.com/',
}

const SOURCE_LABEL: Record<string, string> = {
  live: '',
  sandbox: '测试数据',
  mock: '示例数据',
}

function formatPrice(value: number | undefined | null): string {
  if (typeof value !== 'number') return '—'
  // 整数不显示小数，避免 $10.00 这种冗余
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`
}

/** 用于排序的价格：优先续费价，缺失时回落首年价 */
function sortPrice(q: RegistrarQuoteItem): number {
  const renew = q.renew?.price
  if (typeof renew === 'number' && renew > 0) return renew
  const register = q.register?.price
  if (typeof register === 'number' && register > 0) return register
  return Number.POSITIVE_INFINITY
}

export function PriceCompare({ domain }: { domain: string }) {
  const [data, setData] = useState<PriceComparisonData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')

    fetch(`/api/price?domain=${encodeURIComponent(domain)}`)
      .then(res => res.json())
      .then(json => {
        if (cancelled) return
        if (json.success && json.data) setData(json.data as PriceComparisonData)
        else setError(json.error || '比价查询失败')
      })
      .catch(() => { if (!cancelled) setError('比价查询失败') })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [domain])

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" strokeWidth={2} />
        正在比较各注册商价格…
      </div>
    )
  }

  // 失败或无数据时不渲染空壳，避免页面上出现无意义的区块
  if (error || !data) return null
  if (data.quotes.length === 0) {
    // 只有确实配了注册商却都失败时才提示，否则静默（未配置属于正常状态）
    if (data.errors.length === 0) return null
    return (
      <div className="rounded-xl bg-muted/60 px-4 py-3 text-xs text-muted-foreground">
        暂时无法获取注册商报价。
      </div>
    )
  }

  const sorted = [...data.quotes].sort((a, b) => sortPrice(a) - sortPrice(b))
  const best = sorted[0]
  const bestPrice = sortPrice(best)
  const hasPremium = data.quotes.some(q => q.premium)

  return (
    <div className="space-y-2.5">
      {/* 溢价域名：同一后缀下价格差异极大，必须先讲清楚 */}
      {hasPremium && (
        <div className="flex items-start gap-2 rounded-xl bg-warning/12 px-3.5 py-2 text-xs text-warning">
          <AlertTriangle className="mt-[3px] size-3.5 shrink-0" strokeWidth={2} />
          <span>溢价域名，注册局定价远高于同后缀的普通域名</span>
        </div>
      )}

      <div className="space-y-1.5">
        {/*
          表头：让「续费 / 首年 / 差额」三列的含义一目了然。
          列宽与下方 grid 完全一致，保证纵向对齐。
        */}
        <div className="hidden grid-cols-[5.5rem_6.5rem_3rem] gap-x-4 pr-3.5 sm:grid">
          <span className="text-[11px] text-muted-foreground sm:text-right">续费价</span>
          <span className="text-[11px] text-muted-foreground sm:text-right">首年价</span>
          <span className="text-[11px] text-muted-foreground sm:text-right">差额</span>
        </div>

        {sorted.map((q, index) => {
          const renew = q.renew?.price
          const register = q.register?.price
          // 相对最优价的差额，帮助用户快速判断值得不值得换一家
          const diff = index > 0 && Number.isFinite(bestPrice) && typeof renew === 'number'
            ? renew - bestPrice
            : null
          const isBest = index === 0
          const sourceNote = SOURCE_LABEL[q.source]

          return (
            <div
              key={q.registrar}
              className={cn(
                "flex flex-col gap-1 rounded-xl px-3.5 py-2 sm:flex-row sm:items-center sm:gap-4",
                isBest ? "bg-success/8 ring-1 ring-success/25" : "bg-muted/55"
              )}
            >
              {/* 注册商名与状态标记 */}
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">{q.registrarName}</span>
                {isBest && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
                    <TrendingDown className="size-3" strokeWidth={2} />
                    续费最低
                  </span>
                )}
                {sourceNote && (
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                    {sourceNote}
                  </span>
                )}
                {!q.available && (
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                    不可注册
                  </span>
                )}
              </div>

              {/*
                价格列用 grid 固定列宽，保证三行的「续费 / 首年 / 差额」纵向对齐。
                用 flex 时列宽随文字长度浮动，无法纵向扫读，对比体验很差。
              */}
              <div className="grid shrink-0 grid-cols-[auto_auto_auto] items-baseline gap-x-4 tnum sm:grid-cols-[5.5rem_6.5rem_3rem]">
                <span className="text-sm sm:text-right">
                  <span className="text-[11px] text-muted-foreground">续费 </span>
                  <span className="font-semibold text-foreground">{formatPrice(renew)}</span>
                  <span className="text-[11px] text-muted-foreground">/年</span>
                </span>
                <span className="text-sm sm:text-right">
                  <span className="text-[11px] text-muted-foreground">首年 </span>
                  <span className="text-foreground/80">{formatPrice(register)}</span>
                  {/* 促销时显示标准价，让用户看清到期后会涨到多少 */}
                  {q.register?.onSale && q.register.regularPrice !== q.register.price && (
                    <span className="ml-1 text-[11px] text-muted-foreground line-through">
                      {formatPrice(q.register.regularPrice)}
                    </span>
                  )}
                </span>
                <span className="text-[11px] text-muted-foreground sm:text-right">
                  {diff !== null && diff > 0 ? `+${formatPrice(diff)}` : ''}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Info className="size-3 shrink-0" strokeWidth={2} />
          按续费价排序，数据来自注册商官方接口，以实际结算为准
        </p>
        {best && REGISTRAR_URLS[best.registrar] && (
          <a
            href={REGISTRAR_URLS[best.registrar]}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-primary hover:underline"
          >
            前往 {best.registrarName} →
          </a>
        )}
      </div>
    </div>
  )
}
