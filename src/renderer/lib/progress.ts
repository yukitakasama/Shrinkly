/**
 * 队列进度汇总（纯函数）。
 *
 * 把「每个任务的进度」折叠成界面需要的总体视图：总百分比、当前文件序号、
 * 已处理 / 总大小、阶段、速度、剩余时间与「是否可能卡住」。
 */
import type { JobRecord } from '../../shared/types'

/** 超过该时长没有收到任何进度，就提示「可能卡住 / 正在等待」。 */
export const STALL_THRESHOLD_MS = 20_000

const FINISHED = new Set<JobRecord['status']>(['done', 'failed', 'canceled', 'skipped'])

export interface QueueFailure {
  id: string
  fileName: string
  status: JobRecord['status']
  title: string
  detail: string
}

export interface QueueSummary {
  total: number
  queued: number
  running: number
  preparing: number
  done: number
  failed: number
  canceled: number
  skipped: number
  /** 当前处理文件序号（1 起），没有进行中的任务时为 null。 */
  currentIndex: number | null
  totalFiles: number
  currentName: string | null
  /** 总体百分比（按源文件大小加权；大小未知时按任务数平均）。 */
  percent: number
  processedBytes: number
  totalBytes: number
  /** 面向用户的阶段文案。 */
  stage: string
  speed: number | null
  etaSec: number | null
  /** 最近一次进度时间（ms）。 */
  updatedAt: number | null
  /** 距最近一次进度过去了多少毫秒。 */
  idleMs: number
  /** 有任务在跑但长时间没有进度。 */
  stalled: boolean
  failures: QueueFailure[]
}

function jobSize(job: JobRecord): number {
  if (job.media?.sizeBytes && job.media.sizeBytes > 0) return job.media.sizeBytes
  if (job.estimate?.estimatedBytes && job.estimate.estimatedBytes > 0) return job.estimate.estimatedBytes
  return 0
}

/** 汇总队列状态。`now` 可注入，便于测试。 */
export function summarizeQueue(jobs: JobRecord[], now: number = Date.now()): QueueSummary {
  let queued = 0
  let running = 0
  let preparing = 0
  let done = 0
  let failed = 0
  let canceled = 0
  let skipped = 0
  let totalBytes = 0
  let processedBytes = 0
  let percentSum = 0
  let sizedJobs = 0
  let currentIndex: number | null = null
  let currentName: string | null = null
  let speed: number | null = null
  let etaSec = 0
  let etaKnown = false
  let updatedAt: number | null = null
  let idleStart: number | null = null
  const failures: QueueFailure[] = []

  jobs.forEach((job, index) => {
    const size = jobSize(job)
    totalBytes += size
    if (size > 0) sizedJobs += 1

    switch (job.status) {
      case 'queued':
        queued += 1
        break
      case 'preparing':
        preparing += 1
        if (currentIndex === null) {
          currentIndex = index + 1
          currentName = job.fileName
        }
        break
      case 'running':
        running += 1
        if (currentIndex === null) {
          currentIndex = index + 1
          currentName = job.fileName
        }
        break
      case 'done':
        done += 1
        break
      case 'failed':
        failed += 1
        failures.push({
          id: job.id,
          fileName: job.fileName,
          status: job.status,
          title: job.error?.title ?? '转换失败',
          detail: job.error?.detail ?? ''
        })
        break
      case 'canceled':
        canceled += 1
        break
      case 'skipped':
        skipped += 1
        break
    }

    const progressPercent = FINISHED.has(job.status)
      ? job.status === 'canceled' && job.progress.percent === 0
        ? 0
        : 100
      : job.progress.percent
    percentSum += progressPercent

    if (FINISHED.has(job.status)) {
      // 成功 / 失败都算「已经碰过」的文件；取消与跳过没有实际产出，不计入已处理大小。
      if (job.status === 'done' || job.status === 'failed') processedBytes += size
    } else if (job.status === 'running' || job.status === 'preparing') {
      processedBytes += size * (Math.min(100, Math.max(0, job.progress.percent)) / 100)
      if (job.progress.updatedAt) {
        updatedAt = Math.max(updatedAt ?? 0, job.progress.updatedAt)
      } else if (job.startedAt) {
        updatedAt = Math.max(updatedAt ?? 0, job.startedAt)
      }
      if (job.status === 'running') {
        if (job.progress.speed && job.progress.speed > 0) {
          speed = speed === null ? job.progress.speed : Math.min(speed, job.progress.speed)
        }
        if (job.progress.etaSec !== null) {
          etaSec += job.progress.etaSec
          etaKnown = true
        }
      }
      idleStart = updatedAt
    } else if (job.status === 'queued') {
      const remaining = job.media?.durationSec
      if (remaining && remaining > 0) {
        etaSec += remaining
        etaKnown = true
      }
    }
  })

  const total = jobs.length
  const percent =
    totalBytes > 0
      ? Math.min(100, Math.max(0, (processedBytes / totalBytes) * 100))
      : total > 0
        ? Math.min(100, Math.max(0, percentSum / total))
        : 0

  let stage = '空闲'
  if (preparing > 0) stage = '准备中'
  else if (running > 0) stage = '编码中'
  else if (queued > 0) stage = '等待开始'
  else if (total > 0 && done + failed + canceled + skipped === total) stage = skipped > 0 ? '已跳过' : '已结束'

  const active = running + preparing > 0
  const idleMs = active && idleStart !== null ? Math.max(0, now - idleStart) : 0
  const stalled = active && idleStart !== null && idleMs > STALL_THRESHOLD_MS

  return {
    total,
    queued,
    running,
    preparing,
    done,
    failed,
    canceled,
    skipped,
    currentIndex,
    totalFiles: total,
    currentName,
    percent,
    processedBytes,
    totalBytes,
    stage,
    speed,
    etaSec: etaKnown ? Math.round(etaSec) : null,
    updatedAt,
    idleMs,
    stalled,
    failures
  }
}
