/**
 * 文件：src/components/whois-form.tsx
 * 用途：Whois 查询表单组件，负责输入、类型识别与提交
 * 作者：Ryan
 * 创建日期：2025-09-25
 * 修改记录：
 * - 2025-09-25：添加中文文件头与 JSDoc 注释
 * - 2025-12-15: 重构为现代 UI 风格
 * - 2026-01: 重设计为 Apple/Manus 风格悬浮胶囊搜索框
 */
"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Search, Loader2, Globe, Server, Network, AlertCircle, ArrowRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { detectQueryType } from "@/lib/query-utils"
import { normalizeQueryInput } from "@/lib/query-path"
export { detectQueryType } from "@/lib/query-utils"

interface WhoisFormProps {
  onSubmit: (query: string, type: string, dataSource?: string) => void
  loading: boolean
  defaultValue?: string
}

/** 查询类型 → 图标与中文标签 */
const TYPE_META: Record<string, { icon: typeof Globe; label: string }> = {
  domain: { icon: Globe, label: "域名" },
  ip: { icon: Network, label: "IP / 网段" },
  asn: { icon: Server, label: "ASN" },
}

export function WhoisForm({ onSubmit, loading, defaultValue }: WhoisFormProps) {
  const [query, setQuery] = useState(defaultValue || "")
  const detectedType = detectQueryType(normalizeQueryInput(query))
  const validation = query.trim() ? {
    isValid: detectedType !== 'unknown', type: detectedType,
    message: detectedType === 'unknown' ? '请输入有效的域名、IP / CIDR 或 ASN（1–4294967295）' : undefined,
  } : null
  const [isFocused, setIsFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (defaultValue !== undefined) setQuery(defaultValue)
  }, [defaultValue])

  const handleInputChange = (value: string) => {
    setQuery(value)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (loading || !query.trim() || (validation && !validation.isValid)) return

    const normalizedQuery = normalizeQueryInput(query)
    const autoDetected = detectQueryType(normalizedQuery)
    const detectedType = autoDetected

    if (detectedType === "unknown") {
      return
    }

    onSubmit(normalizedQuery, detectedType, "auto")
  }

  const meta = validation?.type ? TYPE_META[validation.type] : undefined
  const TypeIcon = meta?.icon ?? Search
  const hasError = validation?.isValid === false
  const canSubmit = Boolean(query.trim()) && !hasError

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <form onSubmit={handleSubmit} className="group relative">
        <label htmlFor="whois-query" className="sr-only">域名、IP 或 ASN</label>

        {/* 悬浮胶囊容器 */}
        <div
          className={cn(
            "relative flex w-full items-center gap-1 rounded-full border bg-card p-1.5 transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
            "shadow-[0_1px_3px_oklch(0.22_0.006_264/5%),0_10px_30px_oklch(0.22_0.006_264/8%)]",
            "dark:shadow-[0_1px_3px_oklch(0_0_0/30%),0_10px_30px_oklch(0_0_0/32%)]",
            isFocused
              ? "border-primary/40 shadow-[0_1px_3px_oklch(0.22_0.006_264/5%),0_14px_40px_oklch(0.22_0.006_264/12%)] ring-4 ring-primary/12"
              : "hover:border-foreground/12",
            hasError && "border-destructive/50 ring-4 ring-destructive/10"
          )}
        >
          {/* 左侧类型图标 */}
          <div className="relative z-10 flex size-11 shrink-0 items-center justify-center sm:ml-1.5">
            {loading ? (
              <Loader2 className="size-5 animate-spin text-primary" strokeWidth={2} />
            ) : (
              <TypeIcon
                className={cn(
                  "size-5 transition-colors duration-200",
                  meta ? "text-primary" : "text-muted-foreground"
                )}
                strokeWidth={2}
              />
            )}
          </div>

          <input
            id="whois-query"
            ref={inputRef}
            type="text"
            aria-invalid={hasError}
            aria-describedby={hasError ? "query-error" : undefined}
            className="relative z-10 h-[3.25rem] min-w-0 flex-1 border-none bg-transparent px-1 text-base font-medium tracking-[-0.01em] outline-none placeholder:font-normal placeholder:tracking-normal placeholder:text-muted-foreground/65 sm:text-[17px]"
            placeholder="输入域名、IP 地址或 ASN"
            value={query}
            onChange={(e) => handleInputChange(e.target.value)}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
          />

          {/* 识别类型提示（桌面） */}
          {meta && !loading && (
            <span className="hidden shrink-0 rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium text-muted-foreground sm:inline-block">
              {meta.label}
            </span>
          )}

          {/* 提交按钮 */}
          <Button
            type="submit"
            aria-label="开始查询"
            className={cn(
              "relative z-10 h-11 shrink-0 rounded-full px-4 transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] sm:px-5",
              canSubmit
                ? "scale-100 opacity-100"
                : "pointer-events-none w-0 scale-90 px-0 opacity-0"
            )}
            disabled={loading || hasError}
          >
            {loading ? (
              <Loader2 className="size-4 animate-spin" strokeWidth={2} />
            ) : (
              <ArrowRight className="size-4" strokeWidth={2} />
            )}
            <span className="hidden sm:inline">查询</span>
          </Button>
        </div>

        {/* 错误提示 */}
        <div className={cn(
          "items-center gap-1.5 px-5 text-xs font-medium",
          hasError ? "mt-3 flex text-destructive" : "hidden"
        )}>
          <AlertCircle className="size-3.5 shrink-0" strokeWidth={2} />
          <span id="query-error" role="alert">{validation?.message}</span>
        </div>
      </form>

      {/* 示例 chips */}
      <div className="flex flex-wrap items-center justify-center gap-2 pt-0.5 text-xs text-muted-foreground">
        <span className="font-medium">试试</span>
        {["baidu.com", "8.8.8.8", "AS15169"].map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => handleInputChange(example)}
            className="rounded-full border border-transparent bg-secondary/70 px-3 py-1.5 font-mono text-[11px] transition-all duration-200 hover:border-border hover:bg-accent hover:text-foreground"
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  )
}
