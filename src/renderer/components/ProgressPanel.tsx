import { useEffect, useState } from 'react'
import { summarizeQueue } from '../lib/progress'
import { useAppStore } from '../store'
import { formatBytes, formatEta, formatPercent } from '../lib/format'

/**
 * 队列进度总览：总体百分比、当前文件、已处理大小、阶段、速度、剩余时间，
 * 以及长时间无进度时的「可能卡住」提示与失败任务定位。
 */
export default function ProgressPanel(): React.JSX.Element | null {
  const jobs = useAppStore((state) => state.jobs)
  const selectJob = useAppStore((state) => state.selectJob)
  const cancelAll = useAppStore((state) => state.cancelAll)
  const [now, setNow] = useState(() => Date.now())
  const busy = jobs.some((job) => job.status === 'running' || job.status === 'preparing')

  useEffect(() => {
    if (!busy) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [busy])

  if (jobs.length === 0) return null
  const summary = summarizeQueue(jobs, now)
  const idleSeconds = Math.round(summary.idleMs / 1000)

  return (
    <section className="card progress-panel">
      <div className="progress-head">
        <h3>任务进度</h3>
        <span className={`tag ${summary.stalled ? 'warn' : ''}`}>{summary.stage}</span>
        {summary.currentIndex !== null && (
          <span className="progress-file">
            第 {summary.currentIndex} / {summary.totalFiles} 个文件
            {summary.currentName ? `：${summary.currentName}` : ''}
          </span>
        )}
        {(summary.running > 0 || summary.preparing > 0) && (
          <button type="button" className="link danger" onClick={() => void cancelAll()}>
            取消全部
          </button>
        )}
      </div>

      <div className="progress-track progress-track-lg">
        <div className={`progress-bar ${summary.failed > 0 ? 'is-failed' : ''}`} style={{ width: `${summary.percent}%` }} />
      </div>

      <div className="progress-meta">
        <span>总体 {formatPercent(summary.percent)}</span>
        <span>
          已处理大小 {formatBytes(summary.processedBytes)} / {formatBytes(summary.totalBytes)}
        </span>
        <span>速度 {summary.speed ? `${summary.speed.toFixed(2)}x` : '—'}</span>
        <span>预计剩余 {formatEta(summary.etaSec)}</span>
        {busy && (
          <span className={summary.stalled ? 'is-warning' : ''}>
            最近进度更新 {summary.updatedAt ? `${idleSeconds} 秒前` : '尚未收到'}
          </span>
        )}
      </div>

      {summary.stalled && (
        <p className="stall-warning">
          已 {idleSeconds} 秒没有收到进度更新，可能卡住或正在等待（不会自动中止，可手动取消）。
        </p>
      )}

      <div className="status-counts">
        {summary.done > 0 && <span className="chip ok">成功 {summary.done}</span>}
        {summary.failed > 0 && <span className="chip bad">失败 {summary.failed}</span>}
        {summary.canceled > 0 && <span className="chip muted">已取消 {summary.canceled}</span>}
        {summary.skipped > 0 && <span className="chip muted">已跳过 {summary.skipped}</span>}
        {summary.queued > 0 && <span className="chip">待处理 {summary.queued}</span>}
      </div>

      {summary.failures.length > 0 && (
        <ul className="failure-list">
          {summary.failures.map((failure) => (
            <li key={failure.id}>
              <button type="button" className="link danger" onClick={() => selectJob(failure.id)} title={failure.detail}>
                查看失败详情：{failure.fileName}（{failure.title}）
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
