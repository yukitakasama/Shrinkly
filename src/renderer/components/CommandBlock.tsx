import { useAppStore } from '../store'

/** 只读命令预览 + 复制。 */
export default function CommandBlock(): React.JSX.Element {
  const command = useAppStore((state) => state.command)
  const setToast = useAppStore((state) => state.setToast)

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command)
      setToast({ kind: 'success', message: '命令已复制到剪贴板' })
    } catch {
      setToast({ kind: 'error', message: '复制失败，请手动选择命令文本' })
    }
  }

  return (
    <details className="command-block">
      <summary>
        将执行 <span className="muted">（只读，可复制）</span>
        <button
          type="button"
          className="link"
          onClick={(event) => {
            event.preventDefault()
            void copy()
          }}
        >
          复制
        </button>
      </summary>
      <pre>{command || '选择任务后显示命令'}</pre>
    </details>
  )
}
