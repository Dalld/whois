/**
 * 文件：src/components/header.tsx
 * 用途：顶部导航栏，Apple 风格玻璃拟态
 * 修改记录：
 * - 2025-12-15：重构为现代 UI 风格
 * - 2026-01：重设计为 Apple/Manus 风格玻璃导航
 */
"use client"

import { Button } from "@/components/ui/button"
import { ThemeToggle } from "@/components/theme-toggle"
import { Github, ChevronLeft, History } from "lucide-react"
import Link from "next/link"
import Image from "next/image"
import { cn } from "@/lib/utils"

interface HeaderProps {
  showBack?: boolean
  showHistory?: boolean
  onHistoryClick?: () => void
  isHistoryActive?: boolean
  className?: string
}

export function Header({
  showBack = false,
  showHistory = false,
  onHistoryClick,
  isHistoryActive = false,
  className
}: HeaderProps) {
  return (
    <header className={cn("glass sticky top-0 z-50 w-full", className)}>
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-1.5">
          {showBack && (
            <Button
              variant="ghost"
              size="icon"
              asChild
              className="-ml-2 size-9 rounded-full text-muted-foreground hover:text-foreground"
            >
              <Link href="/" aria-label="返回首页">
                <ChevronLeft className="size-[18px]" strokeWidth={2} />
              </Link>
            </Button>
          )}

          <Link href="/" className="group flex items-center gap-2.5">
            <Image
              src="/logo.svg"
              alt=""
              width={30}
              height={30}
              className="shrink-0 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-105"
            />
            <span className="text-[15px] font-semibold tracking-[-0.01em]">
              Whale Whois
            </span>
          </Link>
        </div>

        <div className="flex items-center gap-1">
          {showHistory && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onHistoryClick}
              aria-label="查询历史"
              className={cn(
                "size-9 rounded-full text-muted-foreground hover:text-foreground",
                isHistoryActive && "bg-accent text-foreground"
              )}
            >
              <History className="size-[18px]" strokeWidth={2} />
            </Button>
          )}

          <Link
            href="https://github.com/fishyu-yu/whois"
            target="_blank"
            aria-label="打开 GitHub 仓库"
          >
            <Button
              variant="ghost"
              size="icon"
              className="size-9 rounded-full text-muted-foreground hover:text-foreground"
            >
              <Github className="size-[18px]" strokeWidth={2} />
            </Button>
          </Link>
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}
