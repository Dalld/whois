/**
 * 手动验证脚本：对真实端点跑一遍比价链路。
 *
 * 无密钥时走 Porkbun 官方 mock 端点（结构一致，无需账号），
 * 用于确认 adapter 的字段映射与聚合排序在真实网络下工作正常。
 *
 * 用法：
 *   node --import tsx scripts/price-check.ts example.com
 *   PORKBUN_API_KEY=pk1_... PORKBUN_SECRET_KEY=... node --import tsx scripts/price-check.ts example.com
 */

import { PorkbunAdapter } from '../src/lib/pricing/porkbun'
import { comparePrices } from '../src/lib/pricing/compare'

const domains = process.argv.slice(2)
if (domains.length === 0) domains.push('example.com')

const apiKey = process.env.PORKBUN_API_KEY
const secretApiKey = process.env.PORKBUN_SECRET_KEY
const adapter = new PorkbunAdapter({ apiKey, secretApiKey })

async function main() {
  const source = apiKey ? (apiKey.startsWith('pk1_sb_') ? 'sandbox' : 'live') : 'mock'
  console.log(`数据源：${source}${source === 'mock' ? '（未配置密钥）' : ''}`)
  if (source === 'mock') {
    // mock 端点返回的是 schema 示例：additional.renewal/transfer 的 price 是字面量
    // "string"，会被 parsePrice 判为无效而显示为 —，这是预期行为。
    console.log('说明：mock 的续费/转移价为占位符 "string"，因此显示为 —。')
    console.log('      配置 PORKBUN_API_KEY / PORKBUN_SECRET_KEY 后可看到真实价格。')
  }
  console.log()

  for (const domain of domains) {
    const result = await comparePrices(domain, [adapter])

    console.log(`── ${result.domain}  (.${result.tld})`)

    for (const q of result.quotes) {
      const fmt = (v: number | undefined | null) => (typeof v === 'number' ? `$${v.toFixed(2)}` : '—')
      const flags = [q.premium ? '溢价' : '', q.available ? '' : '不可注册'].filter(Boolean).join(' ')
      console.log(`   ${q.registrarName.padEnd(10)} 注册 ${fmt(q.register?.price).padStart(9)}` +
        `   续费 ${fmt(q.renew?.price).padStart(9)}` +
        `   转移 ${fmt(q.transfer?.price).padStart(9)}` + (flags ? `   [${flags}]` : ''))
      if (q.register?.onSale) {
        console.log(`   ${''.padEnd(10)} ↑ 首年促销价，标准价 ${fmt(q.register.regularPrice)}`)
      }
    }

    if (result.cheapest) {
      console.log(`   最低（按续费价）：${result.cheapest.registrarName}`)
    }
    for (const e of result.errors) console.log(`   [失败] ${e.registrar}: ${e.message}`)
    console.log()
  }
}

main().catch(error => {
  console.error('执行失败：', error)
  process.exitCode = 1
})
