import { NextRequest, NextResponse } from 'next/server'
import { comparePrices } from '@/lib/pricing/compare'
import { buildAdapters } from '@/lib/pricing/registry'
import type { RegistrarQuote } from '@/lib/pricing/types'

export const runtime = 'nodejs'

/**
 * 域名比价接口。
 *
 * 只使用各家注册商的**官方公开 API**，不抓取任何第三方比价站点。
 *
 * 缓存策略：内存缓存 30 分钟。原因是注册商侧限流严格——
 * Porkbun 为 10 秒 10 次，Cloudflare 的 Check 直连注册局。
 * 同一域名在半小时内重复查询直接命中缓存，不再外连。
 */

const CACHE_TTL = 30 * 60 * 1000
const cache = new Map<string, { data: PricePayload; timestamp: number }>()

interface PricePayload {
  domain: string
  quotes: RegistrarQuote[]
  cheapest: RegistrarQuote | null
  errors: { registrar: string; message: string }[]
  /** 未配置凭证而被跳过的注册商 */
  skipped: string[]
  queriedAt: string
}

/**
 * 只保留可用于展示的字段，避免把 raw 里的原始响应整包发给前端。
 * 用显式列举而非解构剔除，避免产生未使用的中间变量。
 */
function toPublic(quote: RegistrarQuote): RegistrarQuote {
  return {
    registrar: quote.registrar,
    registrarName: quote.registrarName,
    domain: quote.domain,
    tld: quote.tld,
    available: quote.available,
    premium: quote.premium,
    currency: quote.currency,
    register: quote.register,
    renew: quote.renew,
    transfer: quote.transfer,
    minDuration: quote.minDuration,
    fetchedAt: quote.fetchedAt,
    source: quote.source,
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const domain = (searchParams.get('domain') || '').trim().toLowerCase()

  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return NextResponse.json({ success: false, error: '无效的域名', data: null }, { status: 400 })
  }

  const cached = cache.get(domain)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return NextResponse.json({ success: true, data: cached.data, cached: true })
  }

  const adapters = buildAdapters()
  if (adapters.length === 0) {
    return NextResponse.json({
      success: true,
      data: { domain, quotes: [], cheapest: null, errors: [], skipped: [], queriedAt: new Date().toISOString() },
      cached: false,
    })
  }

  const configured = new Set(adapters.map(a => a.id))
  const skipped = ['cloudflare', 'porkbun', 'spaceship'].filter(id => !configured.has(id))

  try {
    const result = await comparePrices(domain, adapters, { timeoutMs: 8000 })
    const payload: PricePayload = {
      domain: result.domain,
      quotes: result.quotes.map(toPublic),
      cheapest: result.cheapest ? toPublic(result.cheapest) : null,
      errors: result.errors,
      skipped,
      queriedAt: result.queriedAt,
    }

    // 有报价才缓存：无报价往往是上游临时故障，缓存会让故障延续半小时
    if (payload.quotes.length > 0) {
      if (cache.size >= 200) cache.delete(cache.keys().next().value!)
      cache.set(domain, { data: payload, timestamp: Date.now() })
    }

    return NextResponse.json({ success: true, data: payload, cached: false })
  } catch (error) {
    const message = error instanceof Error ? error.message : '比价查询失败'
    return NextResponse.json({ success: false, error: message, data: null }, { status: 502 })
  }
}
