export function csvContent(rows: unknown[][]): string {
  return '\uFEFF' + rows.map(row => row.map(value => {
    let text = Array.isArray(value) ? value.join('; ') : value == null ? '' : String(value)
    if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`
    return `"${text.replace(/"/g, '""')}"`
  }).join(',')).join('\r\n')
}

export function exportBasename(query: string): string {
  return `whois-${query.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'query'}`
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Allow the browser to start reading the download before releasing it.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * 将结果导出为紧凑信息卡图片。
 *
 * 旧实现直接克隆整个结果页 DOM，会把「全部字段」表与原始数据一并截入，
 * 导致图片极高（实测 2144×3320）且信息密度低。现改为：由调用方渲染一张
 * 固定宽度的 ExportCard，本函数负责离屏挂载、截图、清理。
 *
 * @param node 已经渲染好的导出卡节点（尚未挂载到文档）
 */
export async function exportResultImage(node: HTMLElement, query: string): Promise<void> {
  const { toBlob } = await import('html-to-image')
  await document.fonts.ready

  const backgroundColor = getComputedStyle(document.body).backgroundColor

  // 先量取卡片自身宽度（此时节点仍在离屏宿主中，尺寸有效）
  const cardWidth = node.offsetWidth || node.scrollWidth

  // 离屏容器：移出视口但保持参与布局，否则 html-to-image 量不到尺寸
  const container = document.createElement('div')
  container.setAttribute('aria-hidden', 'true')
  container.style.cssText = [
    'position:fixed',
    'left:-100000px',
    'top:0',
    'pointer-events:none',
    'z-index:-1',
    'width:max-content',
    `background:${backgroundColor}`,
  ].join(';')

  const wrapper = node.cloneNode(true) as HTMLElement
  // 固定为卡片自身宽度，避免作为块级元素被外层拉满
  Object.assign(wrapper.style, {
    width: cardWidth ? `${cardWidth}px` : '720px',
    maxWidth: 'none',
    margin: '0',
  })
  // 关闭动画与过渡，避免截到中间态
  for (const el of [wrapper, ...wrapper.querySelectorAll<HTMLElement>('*')]) {
    el.style.setProperty('animation', 'none', 'important')
    el.style.setProperty('transition', 'none', 'important')
  }
  container.appendChild(wrapper)
  document.body.appendChild(container)

  try {
    const width = wrapper.scrollWidth
    const height = wrapper.scrollHeight
    if (!width || !height) throw new Error('图片生成失败，请重试。')

    // 限制画布像素总量，避免移动端内存溢出；同时保证清晰度
    const pixelRatio = Math.min(2, 8192 / width, 8192 / height, Math.sqrt(16_000_000 / (width * height)))
    if (pixelRatio < 0.5) throw new Error('内容过长，无法生成清晰图片，请使用 JSON 或 CSV 导出。')

    const blob = await toBlob(wrapper, { backgroundColor, pixelRatio, width, height })
    if (!blob) throw new Error('图片生成失败，请重试。')
    downloadBlob(blob, `${exportBasename(query)}.png`)
  } finally {
    container.remove()
  }
}
