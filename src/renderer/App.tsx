import { useEffect, useState } from 'react'
import AdvancedMode from './components/AdvancedMode'
import FileBrowser from './components/FileBrowser'
import FfmpegStatus from './components/FfmpegStatus'
import ImportBar from './components/ImportBar'
import InfoPanel from './components/InfoPanel'
import JobList from './components/JobList'
import LogDrawer from './components/LogDrawer'
import ResultPanel from './components/ResultPanel'
import SettingsDialog from './components/SettingsDialog'
import SimpleMode from './components/SimpleMode'
import { useAppStore } from './store'

export default function App(): React.JSX.Element {
  const init = useAppStore((state) => state.init)
  const mode = useAppStore((state) => state.mode)
  const setMode = useAppStore((state) => state.setMode)
  const toast = useAppStore((state) => state.toast)
  const setToast = useAppStore((state) => state.setToast)
  const shutdown = useAppStore((state) => state.shutdown)
  const version = useAppStore((state) => state.status?.version)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(timer)
  }, [toast, setToast])

  const quit = (): void => {
    if (window.confirm('确定要退出 Shrinkly 吗？关闭后本页面将无法继续使用。')) void shutdown()
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Shrinkly</h1>
        <span className="app-subtitle">视频压缩与格式转换{version ? ` · v${version}` : ''}</span>
        <FfmpegStatus />
        <button type="button" className="ghost" onClick={() => setSettingsOpen(true)}>
          设置
        </button>
        <button type="button" className="ghost" onClick={quit}>
          退出应用
        </button>
      </header>

      <main className="app-main">
        <aside className="sidebar">
          <ImportBar />
          <JobList />
        </aside>

        <section className="workspace">
          <nav className="mode-tabs">
            <button type="button" className={mode === 'simple' ? 'is-active' : ''} onClick={() => setMode('simple')}>
              简易模式
            </button>
            <button type="button" className={mode === 'advanced' ? 'is-active' : ''} onClick={() => setMode('advanced')}>
              高级模式
            </button>
          </nav>
          <InfoPanel />
          <ResultPanel />
          {mode === 'simple' ? <SimpleMode /> : <AdvancedMode />}
        </section>
      </main>

      <LogDrawer />

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      <FileBrowser />

      {toast && (
        <div className={`toast ${toast.kind}`} onClick={() => setToast(null)}>
          {toast.message}
        </div>
      )}
    </div>
  )
}
