import { useAppStore } from '../store'
import type { JobRecord } from '../../shared/types'
import { formatBytes, formatPercent, formatRatio } from '../lib/format'

const STATUS_LABEL: Record<JobRecord['status'], string> = {
  queued: '等待',
  preparing: '准备中',
  running: '转换中',
  done: '完成',
  failed: '失败',
  canceled: '已取消',
  skipped: '已跳过'
}

function statusClass(status: JobRecord['status']): string {
  switch (status) {
    case 'done':
      return 'badge ok'
    case 'failed':
      return 'badge bad'
    case 'running':
    case 'preparing':
      return 'badge busy'
    case 'canceled':
    case 'skipped':
      return 'badge muted'
    default:
      return 'badge'
  }
}

/** 队列列表：状态、进度、排序、取消与移除。 */
export default function JobList(): React.JSX.Element {
  const jobs = useAppStore((state) => state.jobs)
  const selectedId = useAppStore((state) => state.selectedId)
  const selectJob = useAppStore((state) => state.selectJob)
  const cancelJob = useAppStore((state) => state.cancelJob)
  const removeJob = useAppStore((state) => state.removeJob)
  const moveJob = useAppStore((state) => state.moveJob)
  const clearFinished = useAppStore((state) => state.clearFinished)
  const cancelAll = useAppStore((state) => state.cancelAll)
  const startQueue = useAppStore((state) => state.startQueue)

  if (jobs.length === 0) {
    return <p className="empty-hint">队列为空，先拖入视频文件。</p>
  }

  return (
    <div className="job-list">
      <div className="job-list-head">
        <span>{jobs.length} 个任务</span>
        <span className="head-actions">
          <button type="button" className="link" onClick={() => void startQueue()}>
            全部开始
          </button>
          <button type="button" className="link danger" onClick={() => void cancelAll()}>
            全部取消
          </button>
          <button type="button" className="link" onClick={() => void clearFinished()}>
            清除已结束
          </button>
        </span>
      </div>
      <ul>
        {jobs.map((job) => {
          const running = job.status === 'running' || job.status === 'preparing'
          return (
            <li
              key={job.id}
              className={`job-item ${job.id === selectedId ? 'is-selected' : ''}`}
              onClick={() => selectJob(job.id)}
            >
              <div className="job-row">
                <span className={statusClass(job.status)}>{STATUS_LABEL[job.status]}</span>
                <span className="job-name" title={job.inputPath}>
                  {job.fileName}
                </span>
                <span className="job-percent">
                  {job.status === 'running' ? formatPercent(job.progress.percent) : job.status === 'done' && job.result ? formatRatio(job.result.ratio) : ''}
                </span>
              </div>
              <div className="progress-track">
                <div
                  className={`progress-bar ${job.status === 'failed' ? 'is-failed' : ''}`}
                  style={{ width: `${job.status === 'done' ? 100 : job.progress.percent}%` }}
                />
              </div>
              <div className="job-meta">
                <span>{job.estimate ? `${job.estimate.width}×${job.estimate.height} · ${job.estimate.container.toUpperCase()}` : '——'}</span>
                <span>{job.result ? formatBytes(job.result.sizeBytes) : ''}</span>
                <span className="job-actions">
                  {running ? (
                    <button
                      type="button"
                      className="link danger"
                      onClick={(event) => {
                        event.stopPropagation()
                        void cancelJob(job.id)
                      }}
                    >
                      取消
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="link"
                        onClick={(event) => {
                          event.stopPropagation()
                          void moveJob(job.id, -1)
                        }}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="link"
                        onClick={(event) => {
                          event.stopPropagation()
                          void moveJob(job.id, 1)
                        }}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="link danger"
                        onClick={(event) => {
                          event.stopPropagation()
                          void removeJob(job.id)
                        }}
                      >
                        移除
                      </button>
                    </>
                  )}
                </span>
              </div>
              {job.error && <div className="job-error">{job.error.title}</div>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
