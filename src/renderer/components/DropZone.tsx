import { useCallback, useState } from 'react'
import { useAppStore } from '../store'
import { isNativeWindow } from '../lib/picker'

/**
 * 拖拽 / 点击导入区域。
 *
 * 只有原生窗口拿得到拖入文件的真实路径；浏览器测试模式下不渲染该区域。
 */
export default function DropZone(): React.JSX.Element | null {
  const importPaths = useAppStore((state) => state.importPaths)
  const importing = useAppStore((state) => state.importing)
  const [dragging, setDragging] = useState(false)

  const handleDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDragging(false)
      const bridge = window.shrinkly
      if (!bridge) return
      const files = Array.from(event.dataTransfer.files)
      const paths = files.map((file) => bridge.getPathForFile(file)).filter((value) => value.length > 0)
      if (paths.length > 0) await importPaths(paths)
    },
    [importPaths]
  )

  const pick = useCallback(async (): Promise<void> => {
    const files = await (window.shrinkly?.pickFiles() ?? Promise.resolve([]))
    if (files.length > 0) await importPaths(files)
  }, [importPaths])

  if (!isNativeWindow()) return null

  return (
    <div
      className={`drop-zone ${dragging ? 'is-dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => void pick()}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') void pick()
      }}
    >
      <strong>{importing ? '正在读取文件…' : '拖入视频文件或文件夹'}</strong>
      <span>或点击选择文件 · 支持 MP4 / MKV / WebM / MOV</span>
    </div>
  )
}
