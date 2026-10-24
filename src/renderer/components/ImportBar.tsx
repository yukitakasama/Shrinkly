import { useState } from 'react'
import { isNativeWindow, pickDirectory, pickFiles } from '../lib/picker'
import { useAppStore } from '../store'
import DropZone from './DropZone'

/**
 * 导入入口。
 *
 * 原生窗口：拖拽 / 点击选择文件 + 系统文件夹对话框 + 粘贴路径；
 * 浏览器测试模式：服务端文件浏览器 + 粘贴路径。
 */
export default function ImportBar(): React.JSX.Element {
  const importPaths = useAppStore((state) => state.importPaths)
  const importing = useAppStore((state) => state.importing)
  const [manual, setManual] = useState('')
  const [showManual, setShowManual] = useState(false)
  const native = isNativeWindow()

  const addFiles = async (): Promise<void> => {
    const files = await pickFiles()
    if (files.length > 0) await importPaths(files)
  }

  const addFolder = async (): Promise<void> => {
    const directory = await pickDirectory()
    if (directory) await importPaths([directory])
  }

  return (
    <div className="import-bar">
      {native && <DropZone />}
      <div className="import-actions">
        {!native && (
          <button type="button" className="primary" onClick={() => void addFiles()} disabled={importing}>
            {importing ? '正在读取…' : '添加视频文件'}
          </button>
        )}
        <button type="button" className="ghost" onClick={() => void addFolder()} disabled={importing}>
          添加文件夹
        </button>
        <button type="button" className="link" onClick={() => setShowManual((value) => !value)}>
          {showManual ? '收起路径输入' : '粘贴路径'}
        </button>
      </div>
      <p className="hint">
        {native
          ? '可直接把文件或文件夹拖进窗口；支持 MP4 / MKV / WebM / MOV 等'
          : '在服务端文件浏览器中选取，支持的容器：MP4 / MKV / WebM / MOV 等'}
      </p>

      {showManual && (
        <form
          className="manual-path"
          onSubmit={(event) => {
            event.preventDefault()
            const paths = manual
              .split(/[\n;]/)
              .map((item) => item.trim().replace(/^"|"$/g, ''))
              .filter((item) => item.length > 0)
            if (paths.length > 0) {
              void importPaths(paths)
              setManual('')
            }
          }}
        >
          <textarea
            rows={2}
            placeholder={'每行一个绝对路径，例如：\nD:\\videos\\样片.mp4'}
            value={manual}
            onChange={(event) => setManual(event.target.value)}
            spellCheck={false}
          />
          <button type="submit" className="ghost" disabled={importing || manual.trim().length === 0}>
            添加
          </button>
        </form>
      )}
    </div>
  )
}
