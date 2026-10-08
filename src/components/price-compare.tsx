/**
 * 文件：src/components/price-compare.tsx
 * 用途：后缀比价（一行紧凑条）
 *
 * 版面目标：像 who.cx 那样用一行概括关键信息，不占用顶部摘要卡高度。
 *
 * 形如：`后缀 .cx · 注册 $16.53 · 续费 $16.75 · 最低 Porkbun`
 *
 * ## 数据语义
 *
 * 展示的是**后缀级挂牌价**（非溢价域名），来自注册商官方公开价目接口，
 * 本地缓存、零外连。具体域名是否溢价、是否已被注册，由用户
 * 在注册商页面自行确认。界面上必须说清这一点，避免用户
 * 把挂牌价当成最终结算价。
 *
 * ## 为什么排序用续费价
 *
 * 首年价常被用来引流（`.io` 首年 $28.12 / 续费 $51.80），
 * 按首年价排会得出误导性的「最便宜」。续费价才是长期真实成本。
 */

"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

interface QuoteItem {
  registrar: string
  registrarName: string
  register: number | null
  renew: number | null
  transfer: number | null
  regularRegister: number | null
  onSale: boolean
  currency: string
  website: string
  diff: number | null
}

interface SuffixPriceData {
  tld: string
  candidates: string[]
  initialized: boolean
  hint?: string
  quotes: QuoteItem[]
  cheapest: {
    registrar: string
    registrarName: string
    register: number | null
    renew: number | null
    website: string
  } | null
  missing: string[]
  fetchedAt: string
}

function formatPrice(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || value <= 0) return null
  // 整数不显示小数，避免 $10.00 这种冗余
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`
}

/** 单项：标签 + 值，值可带色调 */
function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'good' | 'warn' }) {
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
  const [data, setData] = useState<SuffixPriceData | null>(null)
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
        if (json.success && json.data) setData(json.data as SuffixPriceData)
        else setError(json.error || '后缀比价查询失败')
      })
      .catch(() => { if (!cancelled) setError('后缀比价查询失败') })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [domain])

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" strokeWidth={2} />
        正在查询后缀价
      </div>
    )
  }

  // 失败或无数据时不渲染空壳
  if (error || !data) return null
  if (data.quotes.length === 0) return null

  const best = data.quotes[0]
  const register = formatPrice(best.register)
  const renew = formatPrice(best.renew)
  const others = data.quotes.slice(1)

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
      <Stat label="后缀" value={`.${data.tld}`} />
      {register && (
        <Stat
          label="注册"
          value={
            <>
              {register}
              {/* 促销时显示删除线标准价，让用户看清到期后的真实价位 */}
              {best.onSale && best.regularRegister !== null && best.regularRegister !== best.register && (
                <span className="ml-1 text-[11px] font-normal text-muted-foreground line-through">
                  {formatPrice(best.regularRegister)}
                </span>
              )}
            </>
          }
        />
      )}
      {renew && <Stat label="续费" value={renew} />}
      <Stat label="最低" value={best.registrarName} tone="good" />

      {others.length > 0 && (
        <span className="text-[11px] text-muted-foreground">另有 {others.length} 家报价</span>
      )}

      {/* 说清是挂牌价而非结算价，避免误导 */}
      <span className="w-full text-[11px] text-muted-foreground sm:w-auto">
        非溢价域名挂牌价，实际以注册商结算为准
      </span>
    </div>
  )
}
