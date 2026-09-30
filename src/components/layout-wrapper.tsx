"use client"

import { ReactNode } from "react"
import { cn } from "@/lib/utils"

export function LayoutWrapper({ children, className }: { children: ReactNode, className?: string }) {
  return (
    <div className={cn("relative flex min-h-screen flex-col overflow-x-hidden bg-background selection:bg-primary/15", className)}>
      {/* 顶部极淡的强调色氛围光，Apple 式空间感 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(60%_100%_at_50%_0%,oklch(0.5615_0.1972_254.6/7%),transparent_70%)] dark:bg-[radial-gradient(60%_100%_at_50%_0%,oklch(0.6812_0.1724_252.4/9%),transparent_70%)]"
      />
      <div className="relative flex flex-1 flex-col">
        {children}
      </div>

      <footer className="relative mt-auto py-8 text-center text-xs text-muted-foreground">
        <p>© {new Date().getFullYear()} Whale Education Co., Ltd.</p>
      </footer>
    </div>
  )
}
