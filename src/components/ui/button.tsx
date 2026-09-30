/**
 * 文件：src/components/ui/button.tsx
 * 用途：按钮组件，封装样式变体与尺寸，提供一致的交互与无障碍支持
 * 作者：Ryan
 * 创建日期：2025-09-25
 * 修改记录：
 * - 2025-09-25：添加中文文件头与 JSDoc 注释
 */
"use client"
import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium tracking-[-0.01em] transition-all duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  {
    variants: {
      variant: {
        /* 主按钮：Apple 实心蓝，按下轻微回弹 */
        default: "bg-primary text-primary-foreground hover:brightness-[1.06] active:scale-[0.97]",
        destructive:
          "bg-destructive text-destructive-foreground hover:brightness-[1.06] active:scale-[0.97] focus-visible:ring-destructive/30",
        /* 描边按钮：浅描边 + 卡片底，悬停靠底色变化 */
        outline:
          "border border-border bg-card text-foreground hover:bg-accent active:scale-[0.97]",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-accent active:scale-[0.97]",
        ghost:
          "hover:bg-accent hover:text-accent-foreground active:scale-[0.97]",
        link: "text-primary underline-offset-4 hover:underline rounded-sm",
      },
      size: {
        default: "h-10 px-4 py-2 has-[>svg]:px-3.5",
        sm: "h-9 gap-1.5 px-3.5 has-[>svg]:px-3",
        lg: "h-12 px-6 has-[>svg]:px-5",
        icon: "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }

/**
 * Button 组件
 * 支持不同视觉变体（variant）与尺寸（size），并支持 asChild 组合用法
 * @example
 * <Button variant="default" size="sm">提交</Button>
 * @property variant - 视觉样式，如 default/secondary/destructive/ghost/link 等
 * @property size - 尺寸，如 sm/md/lg/icon
 * @property disabled - 禁用状态
 * @property asChild - 将按钮样式应用到传入子组件
 */
/**
 * 变体样式说明：用于控制按钮的颜色与边框等视觉效果
 * - default：主按钮
 * - secondary：次级按钮
 * - destructive：危险操作（红色）
 * - outline/ghost：弱强调
 * - link：链接风格（无边框）
 */
/**
 * 尺寸说明：用于控制按钮的高度与左右内边距
 * - sm：小尺寸
 * - md：中等（默认）
 * - lg：大尺寸
 * - icon：方形图标按钮（宽高一致）
 */
