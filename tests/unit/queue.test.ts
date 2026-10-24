import { describe, expect, it } from 'vitest'
import { JobQueue } from '../../src/server/jobs/queue'
import type { Logger } from '../../src/server/logger'
import type { JobRecord } from '../../src/shared/types'
import { makeMedia, makeSpec } from './fixtures'

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger

function createQueue(): { queue: JobQueue; updates: JobRecord[] } {
  const updates: JobRecord[] = []
  const queue = new JobQueue({
    logger,
    getFfmpegPath: () => null,
    getFfprobePath: () => null,
    getCapabilities: () => null,
    getConcurrency: () => 1,
    onJobUpdate: (job) => updates.push(job),
    onProgress: () => undefined,
    onLog: () => undefined
  })
  return { queue, updates }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return
    await sleep(20)
  }
  throw new Error('等待超时')
}

function enqueue(queue: JobQueue): JobRecord {
  return queue.enqueue({ spec: makeSpec(), media: makeMedia(), estimate: null })
}

describe('队列启动时机', () => {
  it('只有入队不会自动开始，任务保持等待', async () => {
    const { queue } = createQueue()
    const job = enqueue(queue)
    await sleep(120)
    expect(job.status).toBe('queued')
    expect(queue.isStarted()).toBe(false)
  })

  it('点击开始后才执行；缺少 ffmpeg 时立即失败而不是停在运行中', async () => {
    const { queue } = createQueue()
    const job = enqueue(queue)
    queue.start()
    expect(queue.isStarted()).toBe(true)
    await waitFor(() => job.status === 'failed')
    expect(job.error?.code).toBe('FFMPEG_MISSING')
    expect(queue.isStarted()).toBe(false)
  })

  it('队列运行期间新导入的任务不会被自动执行', async () => {
    const { queue } = createQueue()
    const first = enqueue(queue)
    queue.start()
    await waitFor(() => first.status === 'failed')

    const second = enqueue(queue)
    await sleep(150)
    expect(second.status).toBe('queued')
    expect(queue.isStarted()).toBe(false)

    queue.start()
    await waitFor(() => second.status === 'failed')
  })

  it('取消等待中的任务后不会再被执行', async () => {
    const { queue } = createQueue()
    const job = enqueue(queue)
    queue.cancel(job.id)
    expect(job.status).toBe('canceled')
    queue.start()
    await sleep(150)
    expect(job.status).toBe('canceled')
  })
})
