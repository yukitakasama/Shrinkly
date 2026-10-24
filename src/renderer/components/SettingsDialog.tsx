import { useAppStore } from '../store'

interface Props {
  onClose: () => void
}

/** 设置面板：默认参数、ffmpeg 路径与安装入口。配置即时保存到 userData/settings.json。 */
export default function SettingsDialog({ onClose }: Props): React.JSX.Element {
  const status = useAppStore((state) => state.status)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const setFfmpegPath = useAppStore((state) => state.setFfmpegPath)
  const installFfmpeg = useAppStore((state) => state.installFfmpeg)
  const setToast = useAppStore((state) => state.setToast)
  const settings = status?.settings

  if (!settings) return <div className="modal-backdrop" />

  const pickDirectory = async (): Promise<void> => {
    const directory = await window.shrinkly.pickDirectory()
    if (directory) await updateSettings({ outputDirectory: directory })
  }

  const pickFfmpeg = async (): Promise<void> => {
    const picked = await window.shrinkly.pickExecutable()
    if (picked) await setFfmpegPath(picked)
  }

  const refresh = async (): Promise<void> => {
    const next = await window.shrinkly.refreshFfmpeg()
    setToast({ kind: next.ffmpeg.state === 'ok' ? 'success' : 'error', message: next.ffmpeg.message })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>设置</h2>
          <button type="button" className="link" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="settings-grid">
          <label>
            默认质量
            <input
              type="number"
              min={0}
              max={100}
              value={settings.defaultQuality}
              onChange={(event) => void updateSettings({ defaultQuality: Number(event.target.value) })}
            />
          </label>
          <label>
            默认冲突策略
            <select
              value={settings.defaultConflict}
              onChange={(event) =>
                void updateSettings({ defaultConflict: event.target.value as typeof settings.defaultConflict })
              }
            >
              <option value="rename">自动重命名</option>
              <option value="ask">询问</option>
              <option value="overwrite">覆盖</option>
              <option value="skip">跳过</option>
            </select>
          </label>
          <label>
            并发任务数
            <input
              type="number"
              min={1}
              max={4}
              value={settings.concurrency}
              onChange={(event) => void updateSettings({ concurrency: Number(event.target.value) })}
            />
          </label>
          <label>
            命名模板
            <input
              type="text"
              value={settings.nameTemplate}
              onChange={(event) => void updateSettings({ nameTemplate: event.target.value })}
            />
          </label>
          <label className="span-2">
            默认输出目录
            <span className="inline-row">
              <input type="text" readOnly value={settings.outputDirectory ?? '（与源文件同目录）'} />
              <button type="button" className="ghost" onClick={() => void pickDirectory()}>
                选择
              </button>
              <button type="button" className="link" onClick={() => void updateSettings({ outputDirectory: null })}>
                清除
              </button>
            </span>
          </label>
          <div className="field-inline span-2">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.hwAccel}
                onChange={(event) => void updateSettings({ hwAccel: event.target.checked })}
              />
              默认启用硬件加速（失败自动回退软件编码）
            </label>
          </div>
          <label className="span-2">
            ffmpeg 路径
            <span className="inline-row">
              <input type="text" readOnly value={status?.ffmpeg.ffmpegPath ?? '未检测到'} />
              <button type="button" className="ghost" onClick={() => void pickFfmpeg()}>
                选择
              </button>
              <button type="button" className="ghost" onClick={() => void refresh()}>
                重新检测
              </button>
              <button type="button" className="ghost" onClick={() => void installFfmpeg()}>
                winget 安装
              </button>
            </span>
          </label>
        </div>

        <p className="hint">
          配置保存在 <code>%APPDATA%\shrinkly\settings.json</code>；命名模板支持 {'{name} {ext} {codec} {resolution} {fps} {q} {index} {date} {time}'}。
        </p>
      </div>
    </div>
  )
}
