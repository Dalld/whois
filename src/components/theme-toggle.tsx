/**
 * 文件：src/components/theme-toggle.tsx
 * 用途：提供主题切换的下拉按钮，支持浅色/深色/系统
 * 作者：Ryan
 * 创建日期：2025-09-25
 * 修改记录：
 * - 2025-09-25：添加中文文件头与 JSDoc 注释
 */
"use client"

import * as React from "react"
import { Moon, Sun, Monitor, Check } from "lucide-react"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/**
 * ThemeToggle 主题切换组件
 * 提供浅色/深色/系统三种主题选择
 * @returns JSX.Element
 */
export function ThemeToggle() {
  /** 来自 next-themes 的 setTheme，用于设置当前主题 */
  const { theme, setTheme } = useTheme()

  const OPTIONS = [
    { value: "light", label: "浅色", icon: Sun },
    { value: "dark", label: "深色", icon: Moon },
    { value: "system", label: "跟随系统", icon: Monitor },
  ] as const

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative size-9 rounded-full text-muted-foreground hover:text-foreground"
        >
          <Sun className="size-[18px] rotate-0 scale-100 transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] dark:-rotate-90 dark:scale-0" strokeWidth={2} />
          <Moon className="absolute size-[18px] rotate-90 scale-0 transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] dark:rotate-0 dark:scale-100" strokeWidth={2} />
          <span className="sr-only">切换主题</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40 rounded-xl">
        {OPTIONS.map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem
            key={value}
            onClick={() => setTheme(value)}
            className="gap-2.5 rounded-lg"
          >
            <Icon className="size-4 text-muted-foreground" strokeWidth={2} />
            <span className="flex-1">{label}</span>
            {theme === value && <Check className="size-3.5 text-primary" strokeWidth={2.5} />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
