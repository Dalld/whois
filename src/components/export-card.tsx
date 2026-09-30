/**
 * 文件：src/components/export-card.tsx
 * 用途：导出图片专用的信息卡
 *
 * 设计意图：直接截图整个结果页会导致图片极高且信息密度低。
 * 这里单独渲染一张固定宽度的卡片，只保留最常需要分享的内容。
 *
 * 视觉风格：极简白卡。层级依靠字号、字重与留白建立，
 * 不使用彩色底纹块；仅状态徽章保留语义色。
 *
 * 该组件在离屏容器中渲染后再截图，因此不使用任何依赖交互状态的样式。
 */
"use client"

import { forwardRef } from "react"

export interface ExportContact {
  /** 姓名 */
  name?: string
  /** 机构 / 组织 */
  organization?: string
  /** 邮箱 */
  email?: string
  /** 电话 */
  phone?: string
  /** 传真 */
  fax?: string
  /** 街道地址 */
  street?: string
  /** 城市 */
  city?: string
  /** 省 / 州 */
  state?: string
  /** 邮编 */
  postalCode?: string
  /** 国家 */
  country?: string
}

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
  /** 注册人 / 资源持有人详情 */
  registrant?: ExportContact | null
  /** 页脚显示的网址 */
  siteUrl: string
  /** 查询时间（已格式化） */
  queriedAt: string
}

/** 域名状态严重度 → 配色 */
const statusTone = (severity: number) => {
  if (severity >= 3) return "bg-red-500/10 text-red-700 dark:text-red-400"
  if (severity === 2) return "bg-amber-500/15 text-amber-700 dark:text-amber-400"
  if (severity === 0) return "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400"
  return "bg-secondary text-secondary-foreground"
}

export const EXPORT_CARD_WIDTH = 720

/** 单行「标签 + 值」，标签固定宽度使各行左对齐 */
function Field({ label, value, mono = false }: { label: string; value?: string; mono?: boolean }) {
  if (!value) return null
  return (
    <div className="flex gap-4 py-[5px]">
      <span className="w-[68px] shrink-0 text-[12px] leading-6 text-muted-foreground">{label}</span>
      <span className={`min-w-0 break-words text-[13px] leading-6 ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  )
}

/**
 * 导出卡：固定 720px 宽，内容自适应高度。
 * 通过 forwardRef 暴露节点，供 html-to-image 截图。
 */
export const ExportCard = forwardRef<HTMLDivElement, { data: ExportCardData; statusTones?: Record<string, number> }>(
  function ExportCard({ data, statusTones = {} }, ref) {
    const {
      title, queryType, sourceLabel, registrar,
      registrationDate, expirationDate, updatedDate, daysRemaining,
      statuses = [], nameServers = [], registrant, siteUrl, queriedAt,
    } = data

    const isNetwork = queryType === 'ip' || queryType === 'asn'
    const typeLabel = queryType === 'ip' ? 'IP / 网段' : queryType === 'asn' ? 'ASN' : '域名'

    // 通讯地址拼装：街道、城市、省州、邮编、国家，仅保留有值的部分
    const address = registrant
      ? [registrant.street, registrant.city, registrant.state, registrant.postalCode, registrant.country]
          .filter(Boolean)
          .join('，')
      : ''

    // 注册人展示名：优先机构，其次姓名
    const registrantHeadline = registrant?.organization || registrant?.name || ''
    // 机构与姓名同时存在时，把姓名作为次级信息显示
    const registrantSecondary = registrant?.organization && registrant?.name ? registrant.name : ''

    const hasRegistrant = Boolean(
      registrantHeadline || registrantSecondary || registrant?.email || registrant?.phone || registrant?.fax || address
    )

    // 域名状态里 Client/Server 各占一条，展开会挤占版面；只保留少量并归并同类
    const statusLimit = 4
    const shownStatuses = statuses.slice(0, statusLimit)
    const hiddenStatusCount = statuses.length - shownStatuses.length

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
        <div className="px-10 pb-8 pt-9">
          {/* 顶部：类型 + 数据来源 */}
          <div className="mb-5 flex items-center gap-3 text-[11px] font-medium text-muted-foreground">
            <span className="rounded-full bg-secondary px-2.5 py-1">{typeLabel}</span>
            {sourceLabel && <span>{sourceLabel}</span>}
          </div>

          {/* 主标题 */}
          <h1 className="break-all text-[31px] font-semibold leading-[1.14] tracking-[-0.028em]">
            {title}
          </h1>

          {/* 状态徽章 */}
          {(!isNetwork && daysRemaining !== null && daysRemaining !== undefined) || statuses.length > 0 ? (
            <div className="mt-4 flex flex-wrap items-center gap-1.5">
              {!isNetwork && daysRemaining !== null && daysRemaining !== undefined && (
                <span className={[
                  "rounded-full px-2.5 py-1 text-[11px] font-medium",
                  daysRemaining < 0
                    ? "bg-red-500/10 text-red-700 dark:text-red-400"
                    : daysRemaining < 30
                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                      : "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
                ].join(" ")}>
                  {daysRemaining > 0 ? `剩余 ${daysRemaining} 天` : "已过期"}
                </span>
              )}
              {shownStatuses.map(status => (
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
              {hiddenStatusCount > 0 && (
                <span className="rounded-full px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                  +{hiddenStatusCount}
                </span>
              )}
            </div>
          ) : null}

          {/* 注册人：紧跟标题，作为核心信息 */}
          {hasRegistrant && (
            <div className="mt-7">
              <div className="mb-2.5 text-[11px] font-medium tracking-wide text-muted-foreground">
                {isNetwork ? '资源持有人' : '注册人'}
              </div>
              {registrantHeadline && (
                <div className="break-words text-[17px] font-medium leading-6 tracking-[-0.012em]">
                  {registrantHeadline}
                </div>
              )}
              {registrantSecondary && (
                <div className="mt-0.5 break-words text-[13px] text-muted-foreground">{registrantSecondary}</div>
              )}
              <div className="mt-2.5">
                <Field label="邮箱" value={registrant?.email} mono />
                <Field label="电话" value={registrant?.phone} mono />
                <Field label="传真" value={registrant?.fax} mono />
                <Field label="地址" value={address} />
              </div>
            </div>
          )}

          <div className="my-7 h-px w-full bg-border" />

          {/* 关键日期 */}
          {dateRows.length > 0 && (
            <div className="mb-7">
              <div className="mb-3 text-[11px] font-medium tracking-wide text-muted-foreground">关键日期</div>
              {dateRows.map(row => (
                <Field key={row.label} label={row.label} value={row.value} mono />
              ))}
            </div>
          )}

          {/* 注册商 / 所属组织 */}
          {registrar && (
            <div className="mb-7">
              <div className="mb-2.5 text-[11px] font-medium tracking-wide text-muted-foreground">
                {isNetwork ? '所属组织' : '注册商'}
              </div>
              <div className="break-words text-[13px] leading-6">{registrar}</div>
            </div>
          )}

          {/* DNS 服务器 */}
          {nameServers.length > 0 && (
            <div className="mb-7">
              <div className="mb-2.5 text-[11px] font-medium tracking-wide text-muted-foreground">DNS 服务器</div>
              <div className="grid grid-cols-2 gap-x-8 gap-y-1">
                {nameServers.slice(0, 8).map(ns => (
                  <div key={ns} className="truncate font-mono text-[12px] leading-6 text-foreground/85">{ns}</div>
                ))}
              </div>
            </div>
          )}

          {/* 页脚：网址 + 查询时间 */}
          <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
            <span className="truncate font-mono text-[12px] text-muted-foreground">{siteUrl}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground">查询于 {queriedAt}</span>
          </div>
        </div>
      </div>
    )
  }
)
