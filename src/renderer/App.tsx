import { useEffect } from 'react'
import FfmpegStatus from './components/FfmpegStatus'
import DropZone from './components/DropZone'
import JobList from './components/JobList'
import InfoPanel from './components/InfoPanel'
import SimpleMode from './components/SimpleMode'
import { useAppStore } from './store'

export default function App(): React.JSX.Element {
  const init = useAppStore((state) => state.init)
  const mode = useAppStore((state) => state.mode)
  const setMode = useAppStore((state) => state.setMode)
  const toast = useAppStore((state) => state.toast)
  const setToast = useAppStore((state) => state.setToast)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(timer)
  }, [toast, setToast])

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Shrinkly</h1>
        <span className="app-subtitle">视频压缩与格式转换</span>
        <FfmpegStatus />
      </header>

      <main className="app-main">
        <aside className="sidebar">
          <DropZone />
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
          {mode === 'simple' ? <SimpleMode /> : <SimpleMode />}
        </section>
      </main>

      {toast && (
        <div className={`toast ${toast.kind}`} onClick={() => setToast(null)}>
          {toast.message}
        </div>
      )}
    </div>
  )
}
