import { useCallback } from 'react'
import { CONTAINER_FORMATS, CONTAINER_INFO, QUALITY_STOPS, qualityLabel } from '../../shared/presets'
import { gpuAvailability } from '../../shared/hardware'
import type { ContainerFormat, HwMode } from '../../shared/types'
import CommandBlock from './CommandBlock'
import { selectedJob, useAppStore } from '../store'
import { previewOutputName } from '../lib/spec'
import { formatBitrate, formatBytes, formatFps, formatPercent, formatRatio } from '../lib/format'

const QUALITY_MIN = 0
const QUALITY_MAX = 100

const HW_OPTIONS: Array<{ value: HwMode; label: string }> = [
  { value: 'auto', label: '自动检测 / 自动选择' },
  { value: 'cpu', label: '使用 CPU' },
  { value: 'gpu', label: '使用 GPU' }
]

/** 简易模式：输出格式 / 硬件加速 / 质量滑块 / 目标体积 / 估算卡 / 命令摘要。 */
export default function SimpleMode(): React.JSX.Element {
  const job = useAppStore((state) => selectedJob(state))
  const jobs = useAppStore((state) => state.jobs)
  const quality = useAppStore((state) => state.quality)
  const targetEnabled = useAppStore((state) => state.targetEnabled)
  const targetMB = useAppStore((state) => state.targetMB)
  const estimate = useAppStore((state) => state.estimate)
  const validation = useAppStore((state) => state.validation)
  const container = useAppStore((state) => state.container)
  const hwMode = useAppStore((state) => state.hwMode)
  const acceleration = useAppStore((state) => state.acceleration)
  const containerHint = useAppStore((state) => state.containerHint)
  const hardware = useAppStore((state) => state.status?.hardware ?? null)
  const nameTemplate = useAppStore((state) => state.status?.settings.nameTemplate ?? '{name}_compressed.{ext}')
  const starting = useAppStore((state) => state.starting)
  const setQuality = useAppStore((state) => state.setQuality)
  const setTarget = useAppStore((state) => state.setTarget)
  const setContainer = useAppStore((state) => state.setContainer)
  const setHwMode = useAppStore((state) => state.setHwMode)
  const rescanHardware = useAppStore((state) => state.rescanHardware)
  const startQueue = useAppStore((state) => state.startQueue)
  const cancelJob = useAppStore((state) => state.cancelJob)

  const ffmpegOk = useAppStore((state) => state.status?.ffmpeg.state === 'ok')
  const hasJob = Boolean(job?.media)
  const gpu = gpuAvailability(hardware, estimate?.videoCodec ?? 'h264')
  const probing = hardware?.state === 'probing'
  const queuedCount = jobs.filter((item) => item.status === 'queued').length
  const busy = jobs.some((item) => item.status === 'running' || item.status === 'preparing')
  const selectedRunning = job?.status === 'running' || job?.status === 'preparing'
  const canStart =
    hasJob && ffmpegOk && Boolean(estimate?.ok) && Boolean(validation?.ok) && queuedCount > 0 && !busy && !starting
  const outputName = job?.media ? previewOutputName(job.media.fileName, container, nameTemplate) : null
  const containerInfo = CONTAINER_INFO[container]

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

  return (
    <section className="card simple-mode">
      <div className="simple-options">
        <label>
          输出格式
          <select
            value={container}
            disabled={!hasJob}
            onChange={(event) => setContainer(event.target.value as ContainerFormat)}
          >
            {CONTAINER_FORMATS.map((item) => (
              <option key={item} value={item}>
                {CONTAINER_INFO[item].label}（.{CONTAINER_INFO[item].extension}）
              </option>
            ))}
          </select>
          <span className="hint">{containerInfo.note}</span>
        </label>
        <label>
          硬件加速
          <span className="inline-row">
            <select
              value={hwMode}
              disabled={!hasJob || probing}
              onChange={(event) => setHwMode(event.target.value as HwMode)}
            >
              {HW_OPTIONS.map((option) => (
                <option
                  key={option.value}
                  value={option.value}
                  disabled={option.value === 'gpu' && !gpu.available && hwMode !== 'gpu'}
                >
                  {option.value === 'gpu' && gpu.available ? `使用 GPU（${gpu.encoder}）` : option.label}
                  {option.value === 'gpu' && !gpu.available ? '（不可用）' : ''}
                </option>
              ))}
            </select>
            <button type="button" className="link" disabled={probing} onClick={() => void rescanHardware()}>
              {probing ? '检测中…' : '重新检测'}
            </button>
          </span>
          <span className={`hint ${gpu.available ? '' : 'is-warning'}`}>{gpu.reason}</span>
        </label>
      </div>

      {containerHint && <p className="inline-note">{containerHint}</p>}
      {outputName && (
        <p className="output-preview">
          输出文件：<code>{outputName}</code>
          <span className="hint">（扩展名随输出格式自动变化）</span>
        </p>
      )}

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
                <span className="tag">{estimate.container.toUpperCase()}</span>
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

      {acceleration && (
        <p className={`compute-line ${acceleration.compute === 'gpu' ? 'is-gpu' : ''}`}>
          计算方式：<strong>{acceleration.label}</strong>
          <span className="hint">{acceleration.reason}</span>
        </p>
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

      <CommandBlock />

      <div className="actions">
        {selectedRunning ? (
          <button type="button" className="danger" onClick={() => job && void cancelJob(job.id)}>
            取消当前任务
          </button>
        ) : (
          <button type="button" className="primary" disabled={!canStart} onClick={() => void startQueue()}>
            {starting ? '正在启动…' : '开始压缩'}
          </button>
        )}
        {queuedCount > 0 && !busy && (
          <span className="hint">待处理 {queuedCount} 个文件，点击「开始压缩」后才会执行</span>
        )}
        {!ffmpegOk && <span className="hint">需要可用的 ffmpeg 才能开始</span>}
        {estimate && !estimate.ok && <span className="hint">{estimate.error?.title}</span>}
        {validation && !validation.ok && <span className="hint">请先修正上方参数错误</span>}
        {busy && !selectedRunning && <span className="hint">队列正在运行，可通过左侧任务列表取消</span>}
        {job?.status === 'running' && <span className="hint">当前进度 {formatPercent(job.progress.percent)}</span>}
      </div>
    </section>
  )
}
