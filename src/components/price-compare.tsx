/**
 * 文件：src/components/price-compare.tsx
 * 用途：域名比价（一行紧凑条）
 *
 * 版面目标：像 who.cx 那样用一行概括关键信息，
 * 不占用顶部摘要卡的高度。
 *
 * 形如：`溢价 否 · 注册 $9.73 · 续费 $12.5 · 状态 已注册`
 *
 * 两个关键取舍：
 * 1. 同时显示注册价与续费价。首年价常被用来引流（$0.99 首年、$29 续费），
 *    只看首年价会得出误导性的「便宜」。
 * 2. 溢价域名必须标出。同一后缀下 $10 与 $1250 不具可比性，
 *    不说明会误导用户。
 *
 * 多注册商时只展示续费价最低的一家，并在括号内标出注册商名，
 * 保持单行版面；完整对比留给后续展开。
 */

"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
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

function formatPrice(value: number | undefined | null): string | null {
  if (typeof value !== 'number' || value <= 0) return null
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

/** 单项：标签 + 值，值可带色调 */
function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'muted' | 'good' | 'warn' }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={cn(
        "text-xs font-medium tnum",
        tone === 'good' && "text-success",
        tone === 'warn' && "text-warning",
        !tone && "text-foreground"
      )}>{value}</span>
    </span>
  )
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
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" strokeWidth={2} />
        正在获取注册商报价
      </div>
    )
  }

  // 失败或无数据时不渲染空壳，避免页面上出现无意义的区块
  if (error || !data) return null
  if (data.quotes.length === 0) return null

  // 只展示续费价最低的一家，保持单行版面
  const sorted = [...data.quotes].sort((a, b) => sortPrice(a) - sortPrice(b))
  const best = sorted[0]
  const register = formatPrice(best.register?.price)
  const renew = formatPrice(best.renew?.price)
  const hasPremium = data.quotes.some(q => q.premium)
  // 同一后缀内还有更便宜的选择时提示，避免只报一家造成误导
  const others = sorted.slice(1)

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
      <Stat
        label="溢价"
        value={hasPremium ? '是' : '否'}
        tone={hasPremium ? 'warn' : undefined}
      />
      {register && <Stat label="注册" value={register} />}
      {renew && <Stat label="续费" value={renew} />}
      <Stat
        label="状态"
        value={best.available ? '已注册' : '可注册'}
        tone={best.available ? undefined : 'good'}
      />

      {/* 注册商名 + 数据来源，弱化处理不抢主信息 */}
      <span className="text-[11px] text-muted-foreground">
        {best.registrarName}
        {best.source !== 'live' && '（示例数据）'}
      </span>

      {others.length > 0 && (
        <span className="text-[11px] text-muted-foreground">
          另有 {others.length} 家报价
        </span>
      )}
    </div>
  )
}
