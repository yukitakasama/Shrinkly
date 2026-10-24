import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useAppStore } from '../store'

const LEVEL_LABEL: Record<'info' | 'warn' | 'error', string> = { info: '信息', warn: '警告', error: '错误' }

/** 底部日志抽屉：搜索、级别过滤、导出。 */
export default function LogDrawer(): React.JSX.Element {
  const logs = useAppStore((state) => state.logs)
  const setToast = useAppStore((state) => state.setToast)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState<'all' | 'info' | 'warn' | 'error'>('all')
  const listRef = useRef<HTMLDivElement | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return logs.filter((entry) => {
      if (level !== 'all' && entry.level !== level) return false
      if (!needle) return true
      return entry.message.toLowerCase().includes(needle) || entry.scope.toLowerCase().includes(needle)
    })
  }, [logs, level, query])

  const visible = filtered.slice(-600)

  useEffect(() => {
    if (!open || !autoScroll) return
    const node = listRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [visible, open, autoScroll])

  const exportLogs = (): void => {
    // 直接让浏览器下载由服务端生成的日志文本
    const link = document.createElement('a')
    link.href = api.logsExportUrl()
    link.download = ''
    document.body.appendChild(link)
    link.click()
    link.remove()
    setToast({ kind: 'success', message: '日志已开始下载（见浏览器下载列表）' })
  }

  return (
    <footer className={`log-drawer ${open ? 'is-open' : ''}`}>
      <div className="log-head">
        <button type="button" className="link" onClick={() => setOpen((value) => !value)}>
          {open ? '▾ 收起日志' : '▸ 日志'}
        </button>
        <input
          type="search"
          placeholder="搜索日志…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select value={level} onChange={(event) => setLevel(event.target.value as typeof level)}>
          <option value="all">全部级别</option>
          <option value="info">信息</option>
          <option value="warn">警告</option>
          <option value="error">错误</option>
        </select>
        <label className="checkbox">
          <input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} />
          自动滚动
        </label>
        <span className="muted">{filtered.length} 条</span>
        <button type="button" className="ghost" onClick={exportLogs}>
          导出
        </button>
      </div>
      {open && (
        <div className="log-body" ref={listRef}>
          {visible.length === 0 && <p className="empty-hint">暂无日志</p>}
          {visible.map((entry, index) => (
            <div key={`${entry.time}-${index}`} className={`log-line ${entry.level}`}>
              <span className="log-time">{new Date(entry.time).toLocaleTimeString()}</span>
              <span className="log-level">{LEVEL_LABEL[entry.level]}</span>
              <span className="log-scope">{entry.scope}</span>
              <span className="log-message">{entry.message}</span>
            </div>
          ))}
        </div>
      )}
    </footer>
  )
}
