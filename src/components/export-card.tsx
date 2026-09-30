/**
 * 文件：src/components/export-card.tsx
 * 用途：导出图片专用的紧凑信息卡
 *
 * 设计意图：直接截图整个结果页会导致图片极高（含全部字段表与原始数据），
 * 信息密度低且不便查看。这里单独渲染一张固定宽度、信息精选的卡片，
 * 只保留最常需要分享的内容。
 *
 * 该组件在离屏容器中渲染后再截图，因此：
 * - 不使用任何依赖交互状态的样式（hover / focus / 动画）
 * - 样式全部为内联或固定 class，避免受外层布局影响
 */
"use client"

import { forwardRef } from "react"

export interface ExportCardData {
  /** 查询对象：域名、IP 或 ASN */
  title: string
  /** 查询类型：domain / ip / asn */
  queryType: string
  /** 数据来源标签，如 "WHOIS · 注册局" */
  sourceLabel?: string | null
  /** 注册商（域名）或所属组织（网络） */
  registrar?: string | null
  /** 关键日期 */
  registrationDate?: string
  expirationDate?: string
  updatedDate?: string
  /** 距到期天数，负数表示已过期 */
  daysRemaining?: number | null
  /** 域名状态标签 */
  statuses?: string[]
  /** 名称服务器 */
  nameServers?: string[]
  /** 联系人摘要（注册人 / 管理员 / 技术 / 账单） */
  contacts?: { label: string; value: string }[]
  /** 页脚显示的网址 */
  siteUrl: string
  /** 查询时间（已格式化） */
  queriedAt: string
}

/** 域名状态严重度 → 配色，与结果页保持一致的语义 */
const statusTone = (severity: number) => {
  if (severity >= 3) return "bg-red-500/10 text-red-700 dark:text-red-400"
  if (severity === 2) return "bg-amber-500/15 text-amber-700 dark:text-amber-400"
  if (severity === 0) return "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400"
  return "bg-secondary text-secondary-foreground"
}

export const EXPORT_CARD_WIDTH = 720

/**
 * 导出卡：固定 720px 宽，内容自适应高度。
 * 通过 forwardRef 暴露节点，供 html-to-image 截图。
 */
export const ExportCard = forwardRef<HTMLDivElement, { data: ExportCardData; statusTones?: Record<string, number> }>(
  function ExportCard({ data, statusTones = {} }, ref) {
    const {
      title, queryType, sourceLabel, registrar,
      registrationDate, expirationDate, updatedDate, daysRemaining,
      statuses = [], nameServers = [], contacts = [], siteUrl, queriedAt,
    } = data

    const isNetwork = queryType === 'ip' || queryType === 'asn'
    const typeLabel = queryType === 'ip' ? 'IP / 网段' : queryType === 'asn' ? 'ASN' : '域名'

    /** 日期行：仅渲染有值的项，避免空行拉高图片 */
    const dateRows = [
      { label: '注册时间', value: registrationDate },
      ...(isNetwork ? [] : [{ label: '过期时间', value: expirationDate }]),
      { label: '更新时间', value: updatedDate },
    ].filter(row => row.value)

    return (
      <div
        ref={ref}
        style={{ width: `${EXPORT_CARD_WIDTH}px` }}
        className="bg-card text-card-foreground"
      >
        <div className="px-9 pb-7 pt-8">
          {/* 顶部：类型标签 + 数据来源 */}
          <div className="mb-4 flex items-center justify-between gap-4">
            <span className="rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              {typeLabel}
            </span>
            {sourceLabel && (
              <span className="text-[11px] font-medium text-muted-foreground">{sourceLabel}</span>
            )}
          </div>

          {/* 主标题：查询对象 */}
          <h1 className="break-all text-[34px] font-semibold leading-[1.15] tracking-[-0.028em]">
            {title}
          </h1>

          {/* 副标题：注册商 / 所属组织 + 到期状态 */}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            {registrar && (
              <span className="max-w-full truncate text-[15px] text-muted-foreground">{registrar}</span>
            )}
            {!isNetwork && daysRemaining !== null && daysRemaining !== undefined && (
              <span className={[
                "rounded-full px-2.5 py-1 text-[12px] font-medium",
                daysRemaining < 0
                  ? "bg-red-500/10 text-red-700 dark:text-red-400"
                  : daysRemaining < 30
                    ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                    : "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
              ].join(" ")}>
                {daysRemaining > 0 ? `剩余 ${daysRemaining} 天` : "已过期"}
              </span>
            )}
          </div>

          {/* 分隔线 */}
          <div className="my-6 h-px w-full bg-border" />

          {/* 关键日期：三列紧凑排布 */}
          {dateRows.length > 0 && (
            <div className="mb-6 grid grid-cols-3 gap-4">
              {dateRows.map(row => (
                <div key={row.label}>
                  <div className="mb-1.5 text-[11px] text-muted-foreground">{row.label}</div>
                  <div className="font-mono text-[13px] font-medium leading-5">{row.value}</div>
                </div>
              ))}
            </div>
          )}

          {/* 域名状态 */}
          {statuses.length > 0 && (
            <div className="mb-6">
              <div className="mb-2.5 text-[11px] font-medium text-muted-foreground">域名状态</div>
              <div className="flex flex-wrap gap-1.5">
                {statuses.slice(0, 8).map(status => (
                  <span
                    key={status}
                    className={[
                      "rounded-full px-2.5 py-1 text-[11px] font-medium",
                      statusTone(statusTones[status] ?? 1),
                    ].join(" ")}
                  >
                    {status}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 联系人 */}
          {contacts.length > 0 && (
            <div className="mb-6">
              <div className="mb-2.5 text-[11px] font-medium text-muted-foreground">联系人</div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                {contacts.map(contact => (
                  <div key={contact.label} className="min-w-0">
                    <div className="mb-0.5 text-[11px] text-muted-foreground">{contact.label}</div>
                    <div className="break-words text-[13px] font-medium leading-5">{contact.value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 名称服务器 */}
          {nameServers.length > 0 && (
            <div className="mb-6">
              <div className="mb-2.5 text-[11px] font-medium text-muted-foreground">DNS 服务器</div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                {nameServers.slice(0, 8).map(ns => (
                  <div key={ns} className="truncate font-mono text-[12px] text-foreground/80">{ns}</div>
                ))}
              </div>
            </div>
          )}

          {/* 页脚：网址 + 查询时间 */}
          <div className="mt-7 flex items-center justify-between gap-4 border-t border-border pt-4">
            <span className="truncate font-mono text-[12px] text-muted-foreground">{siteUrl}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground">查询于 {queriedAt}</span>
          </div>
        </div>
      </div>
    )
  }
)
