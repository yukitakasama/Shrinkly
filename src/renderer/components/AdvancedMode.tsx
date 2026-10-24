import {
  AUDIO_CODEC_LABELS,
  CONTAINER_FORMATS,
  CONTAINER_INFO,
  VIDEO_CODEC_LABELS,
  X264_PRESETS
} from '../../shared/presets'
import type { AudioCodec, ContainerFormat, VideoCodec } from '../../shared/types'
import CommandBlock from './CommandBlock'
import { pickDirectory } from '../lib/picker'
import { selectedJob, useAppStore } from '../store'

/** 高级模式：容器 / 视频 / 音频 / 输出 / 额外参数。 */
export default function AdvancedMode(): React.JSX.Element {
  const job = useAppStore((state) => selectedJob(state))
  const estimate = useAppStore((state) => state.estimate)
  const advanced = useAppStore((state) => state.advanced)
  const container = useAppStore((state) => state.container)
  const videoCodec = useAppStore((state) => state.videoCodec)
  const audioCodec = useAppStore((state) => state.audioCodec)
  const audioMode = useAppStore((state) => state.audioMode)
  const setContainer = useAppStore((state) => state.setContainer)
  const setVideoCodec = useAppStore((state) => state.setVideoCodec)
  const setAudioCodec = useAppStore((state) => state.setAudioCodec)
  const setAudioMode = useAppStore((state) => state.setAudioMode)
  const setAdvanced = useAppStore((state) => state.setAdvanced)
  const resetAdvanced = useAppStore((state) => state.resetAdvanced)
  const pickOutputDirectory = async (): Promise<void> => {
    const directory = await pickDirectory()
    if (directory) setAdvanced({ outputDirectory: directory })
  }
  const startQueue = useAppStore((state) => state.startQueue)
  const validation = useAppStore((state) => state.validation)
  const ffmpegOk = useAppStore((state) => state.status?.ffmpeg.state === 'ok')
  const acceleration = useAppStore((state) => state.acceleration)
  const jobs = useAppStore((state) => state.jobs)
  const starting = useAppStore((state) => state.starting)
  const busy = jobs.some((item) => item.status === 'running' || item.status === 'preparing')
  const queuedCount = jobs.filter((item) => item.status === 'queued').length

  const auto = {
    crf: estimate?.crf ?? 24,
    bitrate: estimate ? Math.round(estimate.videoBitrateKbps) : 2000,
    width: estimate?.width ?? 1920,
    height: estimate?.height ?? 1080,
    frameRate: estimate?.frameRate ?? 30,
    audioBitrate: estimate ? Math.round(estimate.audioBitrateKbps) : 128
  }

  const toggle = (label: string, value: boolean, onChange: (next: boolean) => void) => (
    <label className="checkbox">
      <input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  )

  return (
    <section className="card advanced-mode">
      <div className="advanced-head">
        <span className={advanced ? 'tag' : 'tag muted'}>
          {advanced ? '手动参数（修改后生效）' : '自动推导（改动任一项后转为手动）'}
        </span>
        <button type="button" className="link" onClick={() => resetAdvanced()}>
          重置为自动
        </button>
      </div>

      <details open>
        <summary>容器与编码</summary>
        <div className="field-grid">
          <label>
            容器
            <select value={container} onChange={(event) => setContainer(event.target.value as ContainerFormat)}>
              {CONTAINER_FORMATS.map((item) => (
                <option key={item} value={item}>
                  {CONTAINER_INFO[item].label}
                </option>
              ))}
            </select>
          </label>
          <label>
            视频编码
            <select value={videoCodec} onChange={(event) => setVideoCodec(event.target.value as VideoCodec)}>
              {(Object.keys(VIDEO_CODEC_LABELS) as VideoCodec[]).map((item) => (
                <option key={item} value={item}>
                  {VIDEO_CODEC_LABELS[item]}
                </option>
              ))}
            </select>
          </label>
          <label>
            音频模式
            <select value={audioMode} onChange={(event) => setAudioMode(event.target.value as typeof audioMode)}>
              <option value="encode">重编码</option>
              <option value="copy">复制音轨</option>
              <option value="none">移除音轨</option>
            </select>
          </label>
          <label>
            音频编码
            <select
              value={audioCodec}
              disabled={audioMode !== 'encode'}
              onChange={(event) => setAudioCodec(event.target.value as AudioCodec)}
            >
              {(Object.keys(AUDIO_CODEC_LABELS) as AudioCodec[]).map((item) => (
                <option key={item} value={item}>
                  {AUDIO_CODEC_LABELS[item]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="hint">{CONTAINER_INFO[container].note}</p>
      </details>

      <details>
        <summary>视频</summary>
        <div className="field-grid">
          <label>
            码率控制
            <select
              value={advanced?.rateControl ?? estimate?.rateControl ?? 'crf'}
              onChange={(event) => setAdvanced({ rateControl: event.target.value as 'crf' | 'abr' | 'pass2' })}
            >
              <option value="crf">CRF（恒定画质）</option>
              <option value="abr">ABR（平均码率）</option>
              <option value="pass2">两遍 ABR</option>
            </select>
          </label>
          {(advanced?.rateControl ?? estimate?.rateControl ?? 'crf') === 'crf' ? (
            <label>
              CRF
              <input
                type="number"
                min={0}
                max={63}
                value={advanced?.crf ?? auto.crf}
                onChange={(event) => setAdvanced({ crf: Number(event.target.value) })}
              />
            </label>
          ) : (
            <label>
              视频码率 (kbps)
              <input
                type="number"
                min={50}
                max={80000}
                value={advanced?.bitrateKbps ?? auto.bitrate}
                onChange={(event) => setAdvanced({ bitrateKbps: Number(event.target.value) })}
              />
            </label>
          )}
          <label>
            宽度
            <input
              type="number"
              min={16}
              max={8192}
              step={2}
              value={advanced?.width ?? auto.width}
              onChange={(event) => setAdvanced({ width: Number(event.target.value) })}
            />
          </label>
          <label>
            高度
            <input
              type="number"
              min={16}
              max={8192}
              step={2}
              value={advanced?.height ?? auto.height}
              onChange={(event) => setAdvanced({ height: Number(event.target.value) })}
            />
          </label>
          <label>
            帧率
            <input
              type="number"
              min={1}
              max={120}
              step={0.01}
              value={advanced?.frameRate ?? auto.frameRate}
              onChange={(event) => setAdvanced({ frameRate: Number(event.target.value) })}
            />
          </label>
          <label>
            预设
            <select
              value={advanced?.preset ?? 'medium'}
              onChange={(event) => setAdvanced({ preset: event.target.value })}
            >
              {X264_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {preset}
                </option>
              ))}
            </select>
          </label>
          <label>
            Profile
            <input
              type="text"
              placeholder="例如 main / high"
              value={advanced?.profile ?? ''}
              onChange={(event) => setAdvanced({ profile: event.target.value || null })}
            />
          </label>
          <label>
            Level
            <input
              type="text"
              placeholder="例如 4.1"
              value={advanced?.level ?? ''}
              onChange={(event) => setAdvanced({ level: event.target.value || null })}
            />
          </label>
          <label>
            像素格式
            <input
              type="text"
              placeholder="yuv420p"
              value={advanced?.pixelFormat ?? 'yuv420p'}
              onChange={(event) => setAdvanced({ pixelFormat: event.target.value || null })}
            />
          </label>
          <label>
            GOP
            <input
              type="number"
              min={1}
              max={600}
              value={advanced?.gop ?? ''}
              onChange={(event) => setAdvanced({ gop: event.target.value ? Number(event.target.value) : null })}
            />
          </label>
          <label>
            B 帧
            <input
              type="number"
              min={0}
              max={16}
              value={advanced?.bframes ?? ''}
              onChange={(event) => setAdvanced({ bframes: event.target.value ? Number(event.target.value) : null })}
            />
          </label>
          <div className="field-inline">
            {toggle('硬件加速（失败自动回退）', advanced?.hwAccel ?? false, (next) => setAdvanced({ hwAccel: next }))}
          </div>
          {advanced?.hwAccel && acceleration && (
            <p className={`hint ${acceleration.compute === 'gpu' ? '' : 'is-warning'}`}>{acceleration.reason}</p>
          )}
        </div>
      </details>

      <details>
        <summary>音频</summary>
        <div className="field-grid">
          <label>
            码率 (kbps)
            <input
              type="number"
              min={32}
              max={512}
              disabled={audioMode !== 'encode'}
              value={advanced?.audioBitrateKbps ?? auto.audioBitrate}
              onChange={(event) => setAdvanced({ audioBitrateKbps: Number(event.target.value) })}
            />
          </label>
          <label>
            声道
            <select
              disabled={audioMode !== 'encode'}
              value={advanced?.audioChannels ?? 0}
              onChange={(event) => setAdvanced({ audioChannels: Number(event.target.value) as 0 | 1 | 2 })}
            >
              <option value={0}>保持源声道</option>
              <option value={1}>单声道</option>
              <option value={2}>立体声</option>
            </select>
          </label>
          <label>
            采样率 (Hz)
            <input
              type="number"
              min={8000}
              max={192000}
              disabled={audioMode !== 'encode'}
              value={advanced?.audioSampleRate ?? 48000}
              onChange={(event) => setAdvanced({ audioSampleRate: Number(event.target.value) })}
            />
          </label>
          {audioMode === 'copy' && <p className="hint">复制音轨时码率 / 声道 / 采样率会被忽略。</p>}
          {audioMode === 'none' && <p className="hint">已选择移除音轨，输出将不含音频。</p>}
        </div>
      </details>

      <details>
        <summary>输出</summary>
        <div className="field-grid">
          <label className="span-2">
            输出目录
            <span className="inline-row">
              <input type="text" readOnly value={advanced?.outputDirectory ?? '（与源文件同目录）'} />
              <button type="button" className="ghost" onClick={() => void pickOutputDirectory()}>
                选择
              </button>
              <button type="button" className="link" onClick={() => setAdvanced({ outputDirectory: null })}>
                恢复默认
              </button>
            </span>
          </label>
          <label>
            命名模板
            <input
              type="text"
              value={advanced?.nameTemplate ?? '{name}_compressed.{ext}'}
              onChange={(event) => setAdvanced({ nameTemplate: event.target.value })}
            />
          </label>
          <label>
            同名冲突
            <select
              value={advanced?.conflict ?? 'rename'}
              onChange={(event) => setAdvanced({ conflict: event.target.value as 'ask' | 'rename' | 'overwrite' | 'skip' })}
            >
              <option value="rename">自动重命名</option>
              <option value="ask">询问</option>
              <option value="overwrite">覆盖</option>
              <option value="skip">跳过</option>
            </select>
          </label>
          <div className="field-inline">
            {toggle('保留元数据', advanced?.keepMetadata ?? true, (next) => setAdvanced({ keepMetadata: next }))}
            {toggle('保留章节', advanced?.keepChapters ?? true, (next) => setAdvanced({ keepChapters: next }))}
          </div>
          <label className="span-2">
            额外参数（进阶）
            <textarea
              rows={2}
              placeholder="例如 -x264-params ref=4"
              value={advanced?.extraArgsText ?? ''}
              onChange={(event) => setAdvanced({ extraArgsText: event.target.value })}
            />
          </label>
        </div>
      </details>

      <CommandBlock />

      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={!job?.media || !ffmpegOk || !estimate?.ok || !validation?.ok || queuedCount === 0 || busy || starting}
          onClick={() => void startQueue()}
        >
          {starting ? '正在启动…' : '开始压缩'}
        </button>
        {queuedCount > 0 && !busy && <span className="hint">待处理 {queuedCount} 个文件</span>}
        {busy && <span className="hint">队列正在运行，可先取消再调整参数</span>}
        {validation && !validation.ok && <span className="hint">存在参数错误，请检查上方提示</span>}
      </div>

      {validation && validation.errors.length > 0 && (
        <ul className="issue-list">
          {validation.errors.map((issue) => (
            <li key={`${issue.code}-${issue.field}`} className="issue error">
              <strong>{issue.message}</strong>
              <span>{issue.hint}</span>
            </li>
          ))}
          {validation.warnings.map((issue) => (
            <li key={`w-${issue.code}-${issue.field}`} className="issue warn">
              <strong>{issue.message}</strong>
              <span>{issue.hint}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
