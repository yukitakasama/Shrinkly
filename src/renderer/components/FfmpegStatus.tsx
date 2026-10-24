import { useEffect, useState } from 'react'
import { subscribeEvents } from '../lib/api'
import { pickExecutable } from '../lib/picker'
import { useAppStore } from '../store'

/** 顶部 ffmpeg 状态条：可用 / 缺失 / 无效，并提供安装与自定义路径。 */
export default function FfmpegStatus(): React.JSX.Element {
  const status = useAppStore((state) => state.status)
  const installFfmpeg = useAppStore((state) => state.installFfmpeg)
  const setFfmpegPath = useAppStore((state) => state.setFfmpegPath)
  const [busy, setBusy] = useState(false)
  const [installLine, setInstallLine] = useState<string | null>(null)

  useEffect(() => {
    return subscribeEvents({
      install: (progress) => {
        setInstallLine(progress.line)
        if (progress.phase !== 'running') setBusy(false)
      }
    })
  }, [])

  const ffmpeg = status?.ffmpeg
  if (!ffmpeg) return <div className="ffmpeg-status">检测 ffmpeg…</div>

  const ok = ffmpeg.state === 'ok'

  const pickPath = async (): Promise<void> => {
    const picked = await pickExecutable()
    if (picked) await setFfmpegPath(picked)
  }

  const install = async (): Promise<void> => {
    setBusy(true)
    setInstallLine('正在通过 winget 安装 Gyan.FFmpeg…')
    await installFfmpeg()
    setBusy(false)
  }

  return (
    <div className={`ffmpeg-status ${ok ? 'is-ok' : 'is-bad'}`}>
      <span className="dot" />
      <span className="ffmpeg-label" title={ffmpeg.ffmpegPath ?? undefined}>
        {ok ? `FFmpeg ${ffmpeg.version ?? ''}` : 'FFmpeg 不可用'}
      </span>
      {!ok && (
        <>
          <span className="ffmpeg-message">{ffmpeg.message}</span>
          <button type="button" onClick={install} disabled={busy}>
            {busy ? '安装中…' : '用 winget 安装'}
          </button>
          <button type="button" className="ghost" onClick={pickPath}>
            选择路径
          </button>
        </>
      )}
      {ok && ffmpeg.source === 'custom' && <span className="tag">自定义路径</span>}
      {installLine && <span className="ffmpeg-message">{installLine}</span>}
    </div>
  )
}
