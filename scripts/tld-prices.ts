/**
 * 文件：scripts/tld-prices.ts
 * 用途：后缀比价命令行工具
 *
 * 这是后缀数据的定时任务入口。生产环境应由 cron / Windows 计划任务
 * 定期调用 refresh，让用户查询全部命中本地缓存、零外连。
 *
 * 用法：
 *   node --import tsx scripts/tld-prices.ts refresh          # 刷新已过期的数据源
 *   node --import tsx scripts/tld-prices.ts refresh --force  # 强制全量刷新
 *   node --import tsx scripts/tld-prices.ts compare feng.cx  # 比价
 *   node --import tsx scripts/tld-prices.ts compare cx com io
 *   node --import tsx scripts/tld-prices.ts stats
 *   node --import tsx scripts/tld-prices.ts sources
 */

import { TldPriceStore } from '../src/lib/pricing/tld-store'
import { refreshTldSources, refreshStaleTldSources, compareTld } from '../src/lib/pricing/tld-refresh'
import { buildTldSources } from '../src/lib/pricing/tld-registry'
import { GandiTldSource } from '../src/lib/pricing/gandi-tld'
import { readFileSync, writeFileSync } from 'node:fs'

const DB_PATH = process.env.TLD_DB_PATH ?? '.tld-prices.db'
const TTL_MS = Number.parseInt(process.env.TLD_TTL_MS ?? '', 10) || undefined

const fmt = (v: number | null | undefined) => (typeof v === 'number' ? `$${v.toFixed(2)}` : '—')

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const store = new TldPriceStore({ path: DB_PATH, ttlMs: TTL_MS })
  const sources = buildTldSources()

  try {
    switch (command) {
      case 'refresh': {
        const force = rest.includes('--force')
        const started = Date.now()
        const onProgress = (e: any) => {
          if (e.type === 'start') console.log(`  … ${e.source} 抓取中`)
          if (e.type === 'done') console.log(`  ✓ ${e.source} — ${e.count} 个后缀`)
          if (e.type === 'failed') console.log(`  ✗ ${e.source}: ${e.message}`)
        }
        const report = force
          ? await refreshTldSources(sources, store, { onProgress })
          : await refreshStaleTldSources(sources, store, { onProgress })

        if (report.refreshed.length === 0 && report.errors.length === 0) {
          console.log('全部数据源都是新鲜的，无需刷新（用 --force 强制刷新）')
        } else {
          const total = report.refreshed.reduce((n, r) => n + r.count, 0)
          console.log(`\n刷新 ${report.refreshed.length} 个数据源，共 ${total} 条后缀价，` +
            `耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
          for (const e of report.errors) console.log(`  [失败] ${e.source}: ${e.message}`)
        }
        break
      }

      case 'compare': {
        const inputs = rest.filter(a => !a.startsWith('--'))
        if (inputs.length === 0) {
          console.error('请指定域名或后缀，如：compare feng.cx  或  compare cx com')
          process.exitCode = 1
          return
        }

        for (const input of inputs) {
          const r = compareTld(store, input, { adapters: sources })
          console.log(`\n.${r.tld}  （${r.quotes.length} 家报价）`)
          if (r.quotes.length === 0) {
            console.log('  缓存中没有该后缀，请先执行 refresh')
            continue
          }
          const best = r.quotes[0]
          const bestKey = best.renew ?? best.register
          for (const q of r.quotes) {
            const key = q.renew ?? q.register
            const diff = key !== null && bestKey !== null && q !== best ? key - bestKey : null
            const sale = q.onSale && q.regularRegister !== q.register
              ? `  (促销，标准 ${fmt(q.regularRegister)})` : ''
            console.log(
              `  ${q.registrarName.padEnd(12)}` +
              ` 注册 ${fmt(q.register).padStart(9)}` +
              `  续费 ${fmt(q.renew).padStart(9)}` +
              `  转移 ${fmt(q.transfer).padStart(9)}` +
              (diff !== null && diff > 0 ? `  +${fmt(diff)}` : '') +
              sale,
            )
          }
          if (r.missing.length > 0) console.log(`  未收录：${r.missing.join(', ')}`)
        }
        break
      }

      case 'gandi-scan': {
        // 从 Gandi 的 sitemap 取出全部后缀页，逐个探测哪些有价格，
        // 用于更新 gandi-tld.ts 中的 GANDI_TLDS 清单。
        console.log('拉取 Gandi sitemap…')
        const smRes = await fetch('https://www.gandi.net/sitemap_en-US.xml', {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; whois-tld-compare/1.0)' },
        })
        if (!smRes.ok) throw new Error(`sitemap 请求失败：HTTP ${smRes.status}`)
        const sm = await smRes.text()
        const all = [...sm.matchAll(/<loc>([^<]*\/domain\/tld\/[^<]+)<\/loc>/g)]
          .map(m => decodeURIComponent(m[1].split('/domain/tld/')[1].replace(/\/$/, '')))
        const uniq = [...new Set(all)]
        console.log(`sitemap 列出 ${uniq.length} 个后缀页，开始探测（约需数分钟）…`)

        const src2 = new GandiTldSource()
        const started2 = Date.now()
        const found = await src2.fetchAll({ tlds: uniq, concurrency: 4, delayMs: 60 })
        const tlds = found.map(p => p.tld).sort()

        console.log(`\n探测完成：${tlds.length}/${uniq.length} 个后缀有价格，` +
          `耗时 ${((Date.now() - started2) / 1000 / 60).toFixed(1)} 分钟`)
        console.log(`失败 ${src2.lastErrors.length} 项`)

        const target = 'src/lib/pricing/gandi-tld.ts'
        const content = readFileSync(target, 'utf8')
        const lines: string[] = []
        for (let i = 0; i < tlds.length; i += 12) {
          lines.push('  ' + tlds.slice(i, i + 12).map(t => `'${t}'`).join(', ') + ',')
        }
        const literal = '[\n' + lines.join('\n') + '\n]'
        const re = /const GANDI_TLDS: string\[\] = \[[\s\S]*?\n\]/
        if (!re.test(content)) throw new Error('未能在 gandi-tld.ts 中定位 GANDI_TLDS，请手动更新')
        writeFileSync(target, content.replace(re, `const GANDI_TLDS: string[] = ${literal}`), 'utf8')
        console.log(`已更新 ${target}`)
        break
      }
      case 'stats': {
        const s = store.stats()
        console.log(`后缀数  ：${s.tlds}`)
        console.log(`报价条目：${s.prices}`)
        console.log(`数据源  ：${s.sources}`)
        break
      }

      case 'sources': {
        const list = store.sources()
        if (list.length === 0) {
          console.log('尚无数据，请先执行 refresh')
          break
        }
        console.log('数据源新鲜度：\n')
        for (const s of list) {
          const ageH = (s.ageMs / 3_600_000).toFixed(1)
          console.log(`  ${s.stale ? '·' : '✓'} ${s.source.padEnd(12)} ${String(s.tldCount).padStart(4)} 个后缀` +
            `  ${ageH} 小时前  ${s.stale ? '已过期' : '新鲜'}`)
        }
        break
      }

      default:
        console.log(`用法：
  refresh [--force]        刷新后缀价（默认只刷已过期数据源）
  compare <域名|后缀...>   后缀比价，如 compare feng.cx / compare cx com io
  stats                    缓存统计
  sources                  数据源新鲜度
  gandi-scan               重新探测 Gandi 全部后缀并更新清单（数分钟）

环境变量：
  TLD_DB_PATH   数据库路径（默认 .tld-prices.db）
  TLD_TTL_MS    缓存有效期（默认 24 小时）`)
    }
  } finally {
    store.close()
  }
}

main().catch(error => {
  console.error('执行失败：', error)
  process.exitCode = 1
})