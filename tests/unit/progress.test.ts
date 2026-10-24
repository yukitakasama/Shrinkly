import { describe, expect, it } from 'vitest'
import { STALL_THRESHOLD_MS, summarizeQueue } from '../../src/renderer/lib/progress'
import type { JobRecord, MediaInfo } from '../../src/shared/types'
import { makeMedia } from './fixtures'

function makeJob(overrides: Partial<JobRecord> = {}, media: MediaInfo = makeMedia({ sizeBytes: 100, durationSec: 10 })): JobRecord {
  return {
    id: overrides.id ?? 'job-1',
    inputPath: media.path,
    fileName: media.fileName,
    status: 'queued',
    progress: { percent: 0, timeSec: 0, frame: null, fps: null, speed: null, etaSec: null, bytes: null, updatedAt: null },
    spec: null as unknown as JobRecord['spec'],
    media,
    estimate: null,
    result: null,
    error: null,
    order: 1,
    addedAt: 0,
    startedAt: null,
    finishedAt: null,
    ...overrides
  }
}

const NOW = 1_800_000_000_000

describe('summarizeQueue', () => {
  it('空队列返回零值', () => {
    const summary = summarizeQueue([], NOW)
    expect(summary.total).toBe(0)
    expect(summary.percent).toBe(0)
    expect(summary.stage).toBe('空闲')
    expect(summary.stalled).toBe(false)
  })

  it('只有待处理任务时不会显示成执行中', () => {
    const jobs = [makeJob({ id: 'a' }), makeJob({ id: 'b', order: 2 })]
    const summary = summarizeQueue(jobs, NOW)
    expect(summary.stage).toBe('等待开始')
    expect(summary.queued).toBe(2)
    expect(summary.currentIndex).toBeNull()
    expect(summary.percent).toBe(0)
    expect(summary.totalBytes).toBe(200)
  })

  it('按源文件大小加权计算总体百分比', () => {
    const jobs = [
      makeJob({
        id: 'a',
        order: 1,
        status: 'done',
        result: null
      }),
      makeJob(
        {
          id: 'b',
          order: 2,
          status: 'running',
          progress: { percent: 50, timeSec: 5, frame: null, fps: null, speed: 2, etaSec: 10, bytes: 100, updatedAt: NOW }
        },
        makeMedia({ sizeBytes: 300, durationSec: 20 })
      )
    ]
    const summary = summarizeQueue(jobs, NOW)
    // 100（完成）+ 300×50%（进行中）= 250 / 400
    expect(summary.percent).toBeCloseTo(62.5, 1)
    expect(summary.processedBytes).toBe(250)
    expect(summary.currentIndex).toBe(2)
    expect(summary.stage).toBe('编码中')
    expect(summary.speed).toBe(2)
    expect(summary.etaSec).toBe(10)
  })

  it('长时间没有进度时标记为可能卡住', () => {
    const jobs = [
      makeJob({
        id: 'a',
        status: 'running',
        startedAt: NOW - 60_000,
        progress: { percent: 30, timeSec: 3, frame: null, fps: null, speed: 1, etaSec: 7, bytes: 10, updatedAt: NOW - STALL_THRESHOLD_MS - 5_000 }
      })
    ]
    const summary = summarizeQueue(jobs, NOW)
    expect(summary.stalled).toBe(true)
    expect(summary.idleMs).toBeGreaterThan(STALL_THRESHOLD_MS)
    expect(summary.stage).toBe('编码中')
  })

  it('刚收到进度时不算卡住', () => {
    const jobs = [
      makeJob({
        id: 'a',
        status: 'running',
        startedAt: NOW - 1_000,
        progress: { percent: 5, timeSec: 1, frame: null, fps: null, speed: 1, etaSec: 9, bytes: 10, updatedAt: NOW - 500 }
      })
    ]
    expect(summarizeQueue(jobs, NOW).stalled).toBe(false)
  })

  it('统计成功 / 失败 / 取消 / 跳过，并带上失败定位信息', () => {
    const jobs = [
      makeJob({ id: 'a', order: 1, status: 'done' }),
      makeJob({
        id: 'b',
        order: 2,
        status: 'failed',
        error: { code: 'X', title: '编码器不可用', detail: '详细原因', hint: '提示' }
      }),
      makeJob({ id: 'c', order: 3, status: 'canceled' }),
      makeJob({ id: 'd', order: 4, status: 'skipped' })
    ]
    const summary = summarizeQueue(jobs, NOW)
    expect(summary.done).toBe(1)
    expect(summary.failed).toBe(1)
    expect(summary.canceled).toBe(1)
    expect(summary.skipped).toBe(1)
    expect(summary.failures).toEqual([
      { id: 'b', fileName: jobs[1].fileName, status: 'failed', title: '编码器不可用', detail: '详细原因' }
    ])
    expect(summary.stage).toBe('已跳过')
    // 成功 + 失败计入已处理大小；取消 / 跳过没有产出，不计入。
    expect(summary.processedBytes).toBe(200)
    expect(summary.totalBytes).toBe(400)
  })

  it('准备阶段优先于编码阶段显示', () => {
    const jobs = [
      makeJob({ id: 'a', status: 'running' }),
      makeJob({ id: 'b', order: 2, status: 'preparing' })
    ]
    expect(summarizeQueue(jobs, NOW).stage).toBe('准备中')
  })

  it('大小未知时退化为按任务数平均', () => {
    const unknown = makeMedia({ sizeBytes: 0, durationSec: null })
    const jobs = [
      makeJob({ id: 'a', status: 'done' }, unknown),
      makeJob({ id: 'b', order: 2, status: 'queued' }, unknown)
    ]
    const summary = summarizeQueue(jobs, NOW)
    expect(summary.totalBytes).toBe(0)
    expect(summary.percent).toBe(50)
  })
})
