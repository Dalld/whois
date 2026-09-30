/**
 * 文件：src/lib/pricing/registry.ts
 * 用途：注册商 adapter 注册表与环境变量装配
 *
 * 集中处理「哪些注册商可用」：
 * 只装配配置了凭证的 adapter，未配置的自动跳过，
 * 避免发出必然失败的请求，也避免把错误混进比价结果。
 */

import { CloudflareAdapter } from './cloudflare'
import { PorkbunAdapter } from './porkbun'
import { SpaceshipAdapter } from './spaceship'
import type { RegistrarAdapter } from './types'

/** 全部已知的注册商 adapter 标识 */
export const KNOWN_REGISTRARS = ['cloudflare', 'porkbun', 'spaceship'] as const
export type RegistrarId = (typeof KNOWN_REGISTRARS)[number]

export interface AdapterEnv {
  CLOUDFLARE_ACCOUNT_ID?: string
  CLOUDFLARE_API_TOKEN?: string
  PORKBUN_API_KEY?: string
  PORKBUN_SECRET_KEY?: string
  SPACESHIP_API_KEY?: string
  SPACESHIP_API_SECRET?: string
}

/**
 * 按环境变量装配可用的 adapter。
 *
 * Porkbun 特殊：未配置密钥时会回落到官方 mock 端点，
 * 因此开发期仍会装配它（source 会标记为 mock）。
 * Cloudflare 与 Spaceship 无 mock，未配置则直接跳过。
 */
export function buildAdapters(env: AdapterEnv = process.env as AdapterEnv): RegistrarAdapter[] {
  const adapters: RegistrarAdapter[] = []

  const cloudflare = new CloudflareAdapter({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
  })
  if (cloudflare.isConfigured) adapters.push(cloudflare)

  adapters.push(new PorkbunAdapter({
    apiKey: env.PORKBUN_API_KEY,
    secretApiKey: env.PORKBUN_SECRET_KEY,
  }))

  const spaceship = new SpaceshipAdapter({
    apiKey: env.SPACESHIP_API_KEY,
    apiSecret: env.SPACESHIP_API_SECRET,
  })
  if (spaceship.isConfigured) adapters.push(spaceship)

  return adapters
}

/** 返回各注册商的配置状态，用于诊断与界面提示 */
export function adapterStatus(env: AdapterEnv = process.env as AdapterEnv): {
  id: RegistrarId
  configured: boolean
  note: string
}[] {
  return [
    {
      id: 'cloudflare',
      configured: Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN),
      note: '成本价基准，需账号 ID 与 API Token',
    },
    {
      id: 'porkbun',
      configured: Boolean(env.PORKBUN_API_KEY && env.PORKBUN_SECRET_KEY),
      note: '未配置时使用官方 mock 数据',
    },
    {
      id: 'spaceship',
      configured: Boolean(env.SPACESHIP_API_KEY && env.SPACESHIP_API_SECRET),
      note: '接近成本价，需 API Key 与 Secret',
    },
  ]
}
