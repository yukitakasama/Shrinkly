import { useCallback } from 'react'
import { QUALITY_STOPS, qualityLabel } from '../../shared/presets'
import { selectedJob, useAppStore } from '../store'
import { formatBitrate, formatBytes, formatFps, formatPercent, formatRatio } from '../lib/format'

const QUALITY_MIN = 0
const QUALITY_MAX = 100

/** 简易模式：质量滑块 / 目标体积 / 估算卡 / 命令摘要。 */
export default function SimpleMode(): React.JSX.Element {
  const job = useAppStore((state) => selectedJob(state))
  const quality = useAppStore((state) => state.quality)
  const targetEnabled = useAppStore((state) => state.targetEnabled)
  const targetMB = useAppStore((state) => state.targetMB)
  const estimate = useAppStore((state) => state.estimate)
  const validation = useAppStore((state) => state.validation)
  const command = useAppStore((state) => state.command)
  const setQuality = useAppStore((state) => state.setQuality)
  const setTarget = useAppStore((state) => state.setTarget)
  const startQueue = useAppStore((state) => state.startQueue)
  const setToast = useAppStore((state) => state.setToast)

  const ffmpegOk = useAppStore((state) => state.status?.ffmpeg.state === 'ok')
  const hasJob = Boolean(job?.media)

  const handleKey = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      const step = event.shiftKey ? 10 : 1
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setQuality(Math.max(QUALITY_MIN, quality - step))
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        setQuality(Math.min(QUALITY_MAX, quality + step))
      }
    },
    [quality, setQuality]
  )

  const copyCommand = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command)
      setToast({ kind: 'success', message: '命令已复制到剪贴板' })
    } catch {
      setToast({ kind: 'error', message: '复制失败，请手动选择命令文本' })
    }
  }

  return (
    <section className="card simple-mode">
      <div className="slider-block">
        <div className="slider-head">
          <label htmlFor="quality">质量</label>
          <span className="slider-value">
            {quality} · {qualityLabel(quality)}
          </span>
        </div>
        <input
          id="quality"
          type="range"
          min={QUALITY_MIN}
          max={QUALITY_MAX}
          step={1}
          value={quality}
          onChange={(event) => setQuality(Number(event.target.value))}
          onKeyDown={handleKey}
          disabled={!hasJob || targetEnabled}
        />
        <div className="slider-ticks">
          {QUALITY_STOPS.map((stop) => (
            <button
              type="button"
              key={stop.value}
              className={`tick ${quality === stop.value ? 'is-active' : ''}`}
              onClick={() => setQuality(stop.value)}
              disabled={!hasJob || targetEnabled}
            >
              {stop.label}
            </button>
          ))}
        </div>
      </div>

      <div className="target-block">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={targetEnabled}
            onChange={(event) => setTarget(event.target.checked)}
            disabled={!hasJob}
          />
          指定目标大小
        </label>
        <input
          type="number"
          min={1}
          max={10240}
          value={targetMB}
          onChange={(event) => setTarget(true, Number(event.target.value))}
          disabled={!targetEnabled || !hasJob}
        />
        <span>MB</span>
      </div>

      {estimate && (
        <div className={`estimate-card ${estimate.ok ? '' : 'is-error'}`}>
          {estimate.ok ? (
            <>
              <div className="estimate-main">
                <strong>{formatBytes(estimate.estimatedBytes)}</strong>
                <span className="estimate-ratio">
                  {estimate.ratio > 0 ? formatRatio(estimate.ratio) : '—'}
                  {job?.media ? `（源 ${formatBytes(job.media.sizeBytes)}）` : ''}
                </span>
              </div>
              <div className="estimate-facts">
                <span>
                  {estimate.width}×{estimate.height}
                  {estimate.scaledResolution ? '（已下调）' : ''}
                </span>
                <span>{formatFps(estimate.frameRate)}</span>
                <span>视频 {formatBitrate(estimate.videoBitrateKbps)}</span>
                <span>音频 {estimate.audioBitrateKbps > 0 ? formatBitrate(estimate.audioBitrateKbps) : '无'}</span>
                <span>{estimate.rateControl === 'crf' ? `CRF ${estimate.crf ?? '—'}` : 'ABR'}</span>
                <span className="tag">{estimate.encoder}</span>
              </div>
              <ul className="explain-list">
                {estimate.explanations.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <strong>{estimate.error?.title ?? '无法估算'}</strong>
              <p>{estimate.error?.detail}</p>
              <p className="hint">{estimate.error?.hint}</p>
              {estimate.minimumSizeMB !== null && (
                <p className="hint">
                  最小可达约 <strong>{estimate.minimumSizeMB} MB</strong>
                </p>
              )}
            </>
          )}
        </div>
      )}

      {validation && (validation.errors.length > 0 || validation.warnings.length > 0) && (
        <ul className="issue-list">
          {validation.errors.map((issue) => (
            <li key={`e-${issue.code}-${issue.field}`} className="issue error">
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

      <details className="command-block">
        <summary>
          将执行 <span className="muted">（只读，可复制）</span>
          <button
            type="button"
            className="link"
            onClick={(event) => {
              event.preventDefault()
              void copyCommand()
            }}
          >
            复制
          </button>
        </summary>
        <pre>{command || '选择任务后显示命令'}</pre>
      </details>

      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={!hasJob || !ffmpegOk || !estimate?.ok || !validation?.ok}
          onClick={() => void startQueue()}
        >
          开始转换
        </button>
        {!ffmpegOk && <span className="hint">需要可用的 ffmpeg 才能开始</span>}
        {estimate && !estimate.ok && <span className="hint">{estimate.error?.title}</span>}
        {validation && !validation.ok && <span className="hint">请先修正上方参数错误</span>}
        {job?.status === 'running' && <span className="hint">当前进度 {formatPercent(job.progress.percent)}</span>}
      </div>
    </section>
  )
}
