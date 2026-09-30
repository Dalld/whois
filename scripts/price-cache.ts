/**
 * 文件：scripts/price-cache.ts
 * 用途：价格缓存命令行工具 —— 刷新、查看、诊断
 *
 * 这是定时任务的入口。生产环境应由 cron / Windows 计划任务
 * 按固定间隔调用 `refresh`，让用户查询始终命中缓存。
 *
 * 用法：
 *   node --import tsx scripts/price-cache.ts refresh example.com cloudflare.com
 *   node --import tsx scripts/price-cache.ts refresh --stale      # 只刷新已过期的
 *   node --import tsx scripts/price-cache.ts show example.com
 *   node --import tsx scripts/price-cache.ts stats
 */

import { PriceStore } from '../src/lib/pricing/store'
import { refreshDomains, refreshStale } from '../src/lib/pricing/refresh'
import { adapterStatus, buildAdapters } from '../src/lib/pricing/registry'
import { listRoster, IMPLEMENTED_SLUGS } from '../src/lib/pricing/miqingju'
import type { RegistrarAdapter } from '../src/lib/pricing/types'

const DB_PATH = process.env.PRICE_DB_PATH ?? '.price-cache.db'
const TTL_MS = Number.parseInt(process.env.PRICE_TTL_MS ?? '', 10) || undefined

/** 由注册表按环境变量装配；只有配置了凭证的注册商才会参与 */
function buildAdaptersForRun(): RegistrarAdapter[] {
  return buildAdapters()
}

const fmt = (v: number | undefined | null) => (typeof v === 'number' ? `$${v.toFixed(2)}` : '—')

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const store = new PriceStore({ path: DB_PATH, ttlMs: TTL_MS })
  const adapters = buildAdaptersForRun()

  // roster 只读米情局名册，不依赖任何注册商凭证，故不受此限制
  if (adapters.length === 0 && command !== 'roster') {
    console.error('没有可用的注册商 adapter，请检查环境变量配置')
    process.exitCode = 1
    store.close()
    return
  }

  try {
    switch (command) {
      case 'refresh': {
        const useStale = rest.includes('--stale')
        const domains = rest.filter(a => !a.startsWith('--'))
        if (!useStale && domains.length === 0) {
          console.error('请指定域名，或使用 --stale 刷新所有过期条目')
          process.exitCode = 1
          return
        }

        const started = Date.now()
        const report = useStale
          ? await refreshStale(adapters, store, {
              onProgress: e => {
                if (e.type === 'success') console.log(`  ✓ ${e.domain} — ${e.registrar}`)
                if (e.type === 'rate-limited') console.log(`  ! ${e.registrar} 被限流，暂停 ${e.pauseMs}ms`)
                if (e.type === 'failure' && !e.willRetry) console.log(`  ✗ ${e.domain} — ${e.registrar}: ${e.message}`)
              },
            })
          : await refreshDomains(domains, adapters, store, {
              onProgress: e => {
                if (e.type === 'success') console.log(`  ✓ ${e.domain} — ${e.registrar}`)
                if (e.type === 'rate-limited') console.log(`  ! ${e.registrar} 被限流，暂停 ${e.pauseMs}ms`)
                if (e.type === 'failure' && !e.willRetry) console.log(`  ✗ ${e.domain} — ${e.registrar}: ${e.message}`)
              },
            })

        console.log(`\n完成：刷新 ${report.refreshed} 条，失败 ${report.failed} 个域名，` +
          `耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
        for (const e of report.errors) console.log(`  [失败] ${e.domain} / ${e.registrar}: ${e.message}`)
        break
      }

      case 'show': {
        const domain = rest[0]
        if (!domain) {
          console.error('请指定域名')
          process.exitCode = 1
          return
        }
        const stored = store.getByDomain(domain, true)
        if (stored.length === 0) {
          console.log(`缓存中没有 ${domain} 的记录`)
          return
        }
        for (const s of stored) {
          const q = s.quote
          const flags = [q.premium ? '溢价' : '', q.available ? '' : '不可注册',
            s.expired ? '已过期' : ''].filter(Boolean).join(' ')
          console.log(`${q.registrarName.padEnd(10)} 注册 ${fmt(q.register?.price).padStart(9)}` +
            `  续费 ${fmt(q.renew?.price).padStart(9)}` +
            `  转移 ${fmt(q.transfer?.price).padStart(9)}` +
            `  [${q.source}]` + (flags ? `  ${flags}` : ''))
          if (q.register?.onSale) console.log(`${''.padEnd(10)} 首年促销，标准价 ${fmt(q.register.regularPrice)}`)
        }
        console.log(`\n数据时间：${stored[0].storedAt}   过期时间：${stored[0].expiresAt}`)
        break
      }

      case 'stats': {
        const s = store.stats()
        console.log(`报价条目：${s.quotes}`)
        console.log(`覆盖域名：${s.domains}`)
        console.log(`注册商  ：${s.registrars}`)
        console.log(`价格变动记录：${s.history}`)
        console.log(`最近更新：${store.lastUpdatedAt() ?? '（无数据）'}`)
        break
      }

      case 'roster': {
        /*
          用米情局的开放端点 /stats 列出注册商名册，回答
          「还有哪些家值得接官方 API」。

          只用开放端点；需 PoW 的 /prices 不碰。
        */
        const limit = Number.parseInt(rest.find(a => /^\d+$/.test(a)) ?? '15', 10)
        const showAll = rest.includes('--all')
        const roster = await listRoster({ forceRefresh: rest.includes('--fresh') })

        console.log(`名册：${roster.totalRegistrars} 家注册商 / ` +
          `${roster.totalTlds} 个后缀 / ${roster.totalPrices} 条价格`)
        console.log(`数据时间：${new Date(roster.fetchedAt).toLocaleString()}\n`)

        const done = new Set(Object.values(IMPLEMENTED_SLUGS))
        const rows = showAll ? roster.registrars : roster.registrars.slice(0, limit)
        console.log('  覆盖度  注册商                    官网')
        for (const r of rows) {
          const mark = done.has(r.slug) ? '✓' : '·'
          console.log(`  ${mark} ${String(r.priceCount).padStart(4)}  ${r.name.padEnd(24).slice(0, 24)} ${r.website}`)
        }
        console.log(`\n✓ 为已接入官方 API 的注册商；共 ${done.size} 家`)
        if (!showAll) console.log(`（仅显示覆盖度前 ${limit} 家，用 --all 查看全部）`)
        break
      }

      case 'status': {
        console.log('注册商配置状态：\n')
        for (const s of adapterStatus()) {
          console.log(`  ${s.configured ? '✓' : '·'} ${s.id.padEnd(12)} ${s.configured ? '已配置' : '未配置'}`)
          console.log(`    ${s.note}`)
        }
        console.log(`\n当前参与比价的 adapter：${adapters.map(a => a.id).join(', ')}`)
        break
      }

      default:
        console.log(`用法：
  refresh <域名...>    刷新指定域名
  refresh --stale      刷新所有已过期条目
  show <域名>          查看缓存内容（含过期数据）
  stats                查看缓存统计
  status               查看各注册商配置状态
  roster [N] [--all]   米情局名册：还有哪些家值得接（默认前 15 家）

环境变量：
  PRICE_DB_PATH          数据库路径（默认 .price-cache.db）
  PRICE_TTL_MS           缓存有效期（默认 12 小时）
  MIQINGJU_API_BASE      米情局 API 地址（可指向自建镜像）
  CLOUDFLARE_ACCOUNT_ID  Cloudflare 账号 ID
  CLOUDFLARE_API_TOKEN   Cloudflare API Token
  PORKBUN_API_KEY        Porkbun API key（缺省时走 mock）
  PORKBUN_SECRET_KEY     Porkbun API secret
  SPACESHIP_API_KEY      Spaceship API key
  SPACESHIP_API_SECRET   Spaceship API secret`)
    }
  } finally {
    store.close()
  }
}

main().catch(error => {
  console.error('执行失败：', error)
  process.exitCode = 1
})
