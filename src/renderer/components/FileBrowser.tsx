import { useCallback, useEffect, useState } from 'react'
import type { FsEntry, FsListResponse } from '../../shared/api'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { formatBytes } from '../lib/format'

const TITLES: Record<string, string> = {
  files: '选择视频文件（可多选）',
  directory: '选择文件夹（会递归扫描视频）',
  executable: '选择 ffmpeg 可执行文件'
}

/** 服务端文件浏览器：浏览器拿不到本地路径，所以由服务列出目录供选择。 */
export default function FileBrowser(): React.JSX.Element | null {
  const picker = useAppStore((state) => state.picker)
  const closePicker = useAppStore((state) => state.closePicker)
  const [listing, setListing] = useState<FsListResponse | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [pathInput, setPathInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const mode = picker?.mode ?? 'files'

  const load = useCallback(
    async (target?: string) => {
      if (!picker) return
      setLoading(true)
      setError(null)
      try {
        const response = await api.listDirectory(target, picker.mode === 'executable' ? 'exe' : 'media')
        setListing(response)
        setPathInput(response.path)
        setSelected([])
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setLoading(false)
      }
    },
    [picker]
  )

  useEffect(() => {
    if (picker) void load()
  }, [picker, load])

  if (!picker) return null

  const toggleFile = (entry: FsEntry): void => {
    if (mode === 'files') {
      setSelected((current) =>
        current.includes(entry.path) ? current.filter((item) => item !== entry.path) : [...current, entry.path]
      )
      return
    }
    setSelected([entry.path])
  }

  const confirm = (): void => {
    if (mode === 'directory') {
      if (listing) closePicker([listing.path])
      return
    }
    if (selected.length > 0) closePicker(selected)
  }

  const canConfirm = mode === 'directory' ? Boolean(listing) : selected.length > 0

  return (
    <div className="modal-backdrop" onClick={() => closePicker(null)}>
      <div className="modal file-browser" onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>{TITLES[mode]}</h2>
          <button type="button" className="link" onClick={() => closePicker(null)}>
            取消
          </button>
        </header>

        <div className="fs-toolbar">
          {listing?.roots.map((root) => (
            <button key={root.path} type="button" className="chip" onClick={() => void load(root.path)}>
              {root.label}
            </button>
          ))}
          <button
            type="button"
            className="chip"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && void load(listing.parent)}
          >
            ↑ 上一级
          </button>
        </div>

        <form
          className="fs-path-row"
          onSubmit={(event) => {
            event.preventDefault()
            void load(pathInput.trim() || undefined)
          }}
        >
          <input
            type="text"
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            placeholder="直接输入路径后回车"
            spellCheck={false}
          />
          <button type="submit" className="ghost">
            前往
          </button>
        </form>

        {error && <p className="issue error">{error}</p>}

        <div className={`fs-list ${loading ? 'is-loading' : ''}`}>
          {listing?.entries.length === 0 && <p className="empty-hint">此目录下没有可选择的项目</p>}
          {listing?.entries.map((entry) => {
            const isSelected = selected.includes(entry.path)
            return (
              <div
                key={entry.path}
                className={`fs-entry ${entry.kind === 'dir' ? 'is-dir' : ''} ${isSelected ? 'is-selected' : ''}`}
                onClick={() => {
                  if (entry.kind === 'dir') {
                    if (mode === 'directory' || mode === 'files' || mode === 'executable') void load(entry.path)
                    return
                  }
                  toggleFile(entry)
                }}
              >
                <span className="fs-icon">{entry.kind === 'dir' ? '📁' : '🎬'}</span>
                <span className="fs-name" title={entry.path}>
                  {entry.name}
                </span>
                {entry.kind === 'file' && <span className="fs-size">{formatBytes(entry.sizeBytes)}</span>}
                {entry.kind === 'file' && mode === 'files' && (
                  <input type="checkbox" readOnly checked={isSelected} onClick={(event) => event.stopPropagation()} />
                )}
                {entry.kind === 'file' && mode !== 'files' && isSelected && <span className="tag">已选</span>}
              </div>
            )
          })}
        </div>

        <div className="fs-footer">
          <span className="muted">
            {mode === 'files' ? `已选 ${selected.length} 个文件` : listing ? listing.path : ''}
          </span>
          {mode === 'directory' && listing && (
            <button
              type="button"
              className="ghost"
              onClick={() => closePicker([listing.path])}
              title="选择当前目录并按递归扫描其子目录"
            >
              导入当前文件夹（含子目录）
            </button>
          )}
          <button type="button" className="primary" disabled={!canConfirm} onClick={confirm}>
            {mode === 'directory' ? '选择此目录' : mode === 'executable' ? '使用该文件' : '导入所选'}
          </button>
        </div>
      </div>
    </div>
  )
}
