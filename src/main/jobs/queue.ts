/**
 * 任务队列：并发控制、状态机、进度、取消、硬件编码回退与原子产出。
 *
 * 状态流转：queued → preparing → running → done / failed / canceled / skipped
 */
import { randomUUID } from 'node:crypto'
import { rename, unlink } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { CONTAINER_INFO, CODEC_PROFILES, isHardwareEncoder } from '../../shared/presets'
import type {
  Capabilities,
  ConflictStrategy,
  EstimateResult,
  JobRecord,
  JobResult,
  JobSpec,
  MediaInfo,
  ProgressInfo
} from '../../shared/types'
import type { Logger } from '../logger'
import { classifyFfmpegFailure, isHardwareFailure, asJobError, AppError } from '../ffmpeg/errors'
import { buildFfmpegArgs } from '../ffmpeg/args'
import { probeFile } from '../ffmpeg/probe'
import { runFfmpeg } from '../ffmpeg/runner'
import {
  baseNameContext,
  cleanupStaleParts,
  freeSpaceBytes,
  isDirectoryWritable,
  renderNameTemplate,
  resolveOutputPath,
  temporaryPath
} from '../fs/paths'

export interface QueueDeps {
  logger: Logger
  getFfmpegPath: () => string | null
  getFfprobePath: () => string | null
  getCapabilities: () => Capabilities | null
  getConcurrency: () => number
  onJobUpdate: (job: JobRecord) => void
  onProgress: (jobId: string, progress: ProgressInfo) => void
  onLog: (jobId: string, line: string) => void
}

export interface EnqueueInput {
  spec: JobSpec
  media: MediaInfo | null
  estimate: EstimateResult | null
}

function createRecord(input: EnqueueInput, order: number): JobRecord {
  const fileName = basename(input.spec.inputPath)
  return {
    id: randomUUID(),
    inputPath: input.spec.inputPath,
    fileName,
    status: 'queued',
    progress: { percent: 0, timeSec: 0, frame: null, fps: null, speed: null, etaSec: null, bytes: null },
    spec: input.spec,
    media: input.media,
    estimate: input.estimate,
    result: null,
    error: null,
    order,
    addedAt: Date.now(),
    startedAt: null,
    finishedAt: null
  }
}

export class JobQueue {
  private readonly jobs = new Map<string, JobRecord>()
  private order: string[] = []
  private readonly running = new Map<string, { cancel: () => void }>()
  private activeCount = 0
  private nextOrder = 1
  private started = false

  constructor(private readonly deps: QueueDeps) {}

  list(): JobRecord[] {
    return this.order
      .map((id) => this.jobs.get(id))
      .filter((job): job is JobRecord => Boolean(job))
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id)
  }

  isRunning(id: string): boolean {
    return this.running.has(id)
  }

  /** 开始处理队列；未开始时只入队不执行，便于先调整参数。 */
  start(): void {
    this.started = true
    this.pump()
  }

  isStarted(): boolean {
    return this.started
  }

  enqueue(input: EnqueueInput): JobRecord {
    const record = createRecord(input, this.nextOrder)
    this.nextOrder += 1
    this.jobs.set(record.id, record)
    this.order.push(record.id)
    this.deps.logger.info('queue', `入队 ${record.fileName}（${record.spec.container.toUpperCase()} / ${record.spec.video.codec}）`)
    this.deps.onJobUpdate(record)
    if (this.started) this.pump()
    return record
  }

  updateSpec(id: string, spec: JobSpec, estimate?: EstimateResult | null): JobRecord | undefined {
    const job = this.jobs.get(id)
    if (!job || job.status === 'running') return job
    job.spec = spec
    if (estimate !== undefined) job.estimate = estimate
    this.deps.onJobUpdate(job)
    return job
  }

  /** 调整队列顺序（仅影响等待中的任务）。 */
  move(id: string, delta: number): void {
    const index = this.order.indexOf(id)
    if (index < 0) return
    const target = Math.min(this.order.length - 1, Math.max(0, index + delta))
    if (target === index) return
    const [moved] = this.order.splice(index, 1)
    this.order.splice(target, 0, moved)
    this.order.forEach((jobId, position) => {
      const job = this.jobs.get(jobId)
      if (job) job.order = position + 1
    })
    for (const job of this.list()) this.deps.onJobUpdate(job)
  }

  remove(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    if (this.running.has(id)) this.cancel(id)
    this.jobs.delete(id)
    this.order = this.order.filter((jobId) => jobId !== id)
  }

  clearFinished(): void {
    for (const job of this.list()) {
      if (['done', 'failed', 'canceled', 'skipped'].includes(job.status)) this.remove(job.id)
    }
  }

  cancel(id: string): void {
    const handle = this.running.get(id)
    const job = this.jobs.get(id)
    if (handle) {
      handle.cancel()
      this.deps.logger.warn('queue', `取消任务 ${job?.fileName ?? id}`)
      return
    }
    if (job && job.status === 'queued') {
      job.status = 'canceled'
      job.finishedAt = Date.now()
      this.deps.onJobUpdate(job)
    }
  }

  cancelAll(): void {
    for (const id of this.order) this.cancel(id)
  }

  /** 启动排队中的任务（按并发上限填充）。未 start 时不会执行。 */
  pump(): void {
    if (!this.started) return
    const limit = Math.max(1, this.deps.getConcurrency())
    while (this.activeCount < limit) {
      const next = this.list().find((job) => job.status === 'queued')
      if (!next) return
      this.activeCount += 1
      void this.runJob(next.id).finally(() => {
        this.activeCount -= 1
        this.pump()
      })
    }
  }

  private emit(job: JobRecord): void {
    this.deps.onJobUpdate({ ...job })
  }

  private log(job: JobRecord, line: string): void {
    this.deps.logger.info('ffmpeg', `[${job.fileName}] ${line}`)
    this.deps.onLog(job.id, line)
  }

  private async runJob(id: string): Promise<void> {
    const job = this.jobs.get(id)
    if (!job || job.status !== 'queued') return

    let temporary: string | null = null
    const ffmpegPath = this.deps.getFfmpegPath()
    const ffprobePath = this.deps.getFfprobePath()

    try {
      job.status = 'preparing'
      this.emit(job)

      if (!ffmpegPath) {
        throw new AppError({
          code: 'FFMPEG_MISSING',
          title: '未检测到 ffmpeg',
          detail: '当前没有可用的 ffmpeg，任务无法启动。',
          hint: '请用「安装 ffmpeg」按钮通过 winget 安装，或在设置里指定 ffmpeg.exe 路径。'
        })
      }

      const outputDirectory = job.spec.output.directory ?? dirname(job.spec.inputPath)
      const writable = await isDirectoryWritable(outputDirectory)
      if (!writable) {
        throw new AppError({
          code: 'OUTPUT_NOT_WRITABLE',
          title: '输出目录不可写',
          detail: `无法在 ${outputDirectory} 创建文件。`,
          hint: '请改用当前用户可写的目录（例如「视频」文件夹或桌面）。'
        })
      }

      // 清理本应用遗留的 .part 文件（只清理 1 天前的）。
      const stale = await cleanupStaleParts(outputDirectory)
      if (stale.length > 0) this.log(job, `[cleanup] 已清理 ${stale.length} 个过期临时文件`)

      const containerInfo = CONTAINER_INFO[job.spec.container]
      const context = baseNameContext(job.spec.inputPath, containerInfo.extension)
      const estimate = job.estimate
      const resolutionLabel = estimate
        ? `${Math.min(estimate.width, estimate.height)}p`
        : context.resolution
      const requestedName = renderNameTemplate(job.spec.output.nameTemplate, {
        ...context,
        codec: job.spec.video.codec,
        resolution: resolutionLabel,
        fps: estimate ? `${Math.round(estimate.frameRate)}fps` : context.fps,
        q: estimate ? estimate.quality : context.q,
        index: job.order
      })

      let resolved = await resolveOutputPath({
        directory: outputDirectory,
        requestedName,
        conflict: job.spec.output.conflict,
        avoidPaths: [job.spec.inputPath]
      })
      if (resolved.action === 'ask') {
        // 无交互场景（批量）按自动重命名处理，避免任务挂起。
        resolved = await resolveOutputPath({
          directory: outputDirectory,
          requestedName,
          conflict: 'rename',
          avoidPaths: [job.spec.inputPath]
        })
      }
      if (resolved.action === 'skip') {
        job.status = 'skipped'
        job.finishedAt = Date.now()
        this.log(job, `[skip] 目标文件已存在，按策略跳过：${resolved.path}`)
        this.emit(job)
        return
      }

      // 磁盘空间检查（按估算体积，未知时用源体积）。
      const freeBytes = await freeSpaceBytes(outputDirectory)
      const neededBytes = estimate?.estimatedBytes || job.media?.sizeBytes || 0
      if (freeBytes !== null && neededBytes > 0 && freeBytes < neededBytes * 1.1) {
        throw new AppError({
          code: 'DISK_FULL',
          title: '磁盘空间不足',
          detail: `目标磁盘可用 ${(freeBytes / 1024 / 1024).toFixed(0)} MB，预计需要 ${(neededBytes / 1.05 / 1024 / 1024).toFixed(0)} MB。`,
          hint: '请清理磁盘或更换输出目录后重试。'
        })
      }

      temporary = temporaryPath(resolved.path)
      const encodeOnce = async (spec: JobSpec): Promise<Awaited<ReturnType<typeof runFfmpeg>['promise']>> => {
        const args = buildFfmpegArgs({
          spec,
          input: spec.inputPath,
          output: temporary as string,
          includeProgress: true,
          bitrateCapKbps: spec.video.rateControl === 'crf' && estimate ? Math.round(estimate.videoBitrateKbps * 1.25) : null,
          media: job.media
        })
        this.log(job, `[cmd] ${args.join(' ')}`)
        const handle = runFfmpeg({
          ffmpegPath,
          args,
          durationSec: job.media?.durationSec ?? null,
          onProgress: (progress) => {
            job.progress = progress
            this.deps.onProgress(job.id, progress)
          },
          onLogLine: (line) => this.deps.onLog(job.id, line)
        })
        this.running.set(job.id, handle)
        try {
          return await handle.promise
        } finally {
          this.running.delete(job.id)
        }
      }

      job.status = 'running'
      job.startedAt = Date.now()
      this.emit(job)

      let hwFallback = false
      let outcome = await encodeOnce(job.spec)
      const encoder = job.spec.video.encoder ?? CODEC_PROFILES[job.spec.video.codec].softwareEncoder

      if (outcome.code !== 0 && !outcome.canceled && isHardwareEncoder(encoder) && isHardwareFailure(outcome.stderrTail)) {
        hwFallback = true
        const softwareEncoder = CODEC_PROFILES[job.spec.video.codec].softwareEncoder
        this.log(job, `[hw-fallback] 硬件编码器 ${encoder} 初始化失败，改用 ${softwareEncoder} 重试`)
        const softSpec: JobSpec = {
          ...job.spec,
          video: { ...job.spec.video, encoder: softwareEncoder, hwAccel: false }
        }
        job.progress = { percent: 0, timeSec: 0, frame: null, fps: null, speed: null, etaSec: null, bytes: null }
        outcome = await encodeOnce(softSpec)
      }

      if (outcome.canceled) {
        await unlink(temporary).catch(() => undefined)
        job.status = 'canceled'
        job.finishedAt = Date.now()
        job.progress = { percent: 0, timeSec: 0, frame: null, fps: null, speed: null, etaSec: null, bytes: null }
        this.log(job, '[cancel] 任务已取消，临时文件已删除')
        this.emit(job)
        return
      }

      if (outcome.code !== 0) {
        await unlink(temporary).catch(() => undefined)
        job.status = 'failed'
        job.error = classifyFfmpegFailure(outcome.stderrTail, outcome.code)
        job.finishedAt = Date.now()
        this.log(job, `[error] ${job.error.title}：${job.error.detail}`)
        this.emit(job)
        return
      }

      await this.commitOutput(temporary, resolved.path, job.spec.output.conflict)

      const actualEncoder = hwFallback
        ? CODEC_PROFILES[job.spec.video.codec].softwareEncoder
        : encoder
      const result = await this.buildResult({
        job,
        outputPath: resolved.path,
        elapsedMs: outcome.elapsedMs,
        encoder: actualEncoder,
        hwFallback,
        ffprobePath
      })

      job.result = result
      job.status = 'done'
      job.progress = { ...job.progress, percent: 100 }
      job.finishedAt = Date.now()
      this.log(job, `[done] ${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB，耗时 ${(result.elapsedMs / 1000).toFixed(1)}s`)
      this.emit(job)
    } catch (error) {
      if (temporary) await unlink(temporary).catch(() => undefined)
      job.status = 'failed'
      job.error = asJobError(error)
      job.finishedAt = Date.now()
      this.deps.logger.error('queue', `任务失败 ${job.fileName}: ${job.error.title} / ${job.error.detail}`)
      this.log(job, `[error] ${job.error.title}：${job.error.detail}`)
      this.emit(job)
    } finally {
      this.running.delete(job.id)
    }
  }

  /** 原子产出：临时文件 rename 到最终路径（overwrite 先删旧文件）。 */
  private async commitOutput(temporary: string, finalPath: string, conflict: ConflictStrategy): Promise<void> {
    if (conflict === 'overwrite') {
      await unlink(finalPath).catch(() => undefined)
    }
    await rename(temporary, finalPath)
  }

  private async buildResult(params: {
    job: JobRecord
    outputPath: string
    elapsedMs: number
    encoder: string
    hwFallback: boolean
    ffprobePath: string | null
  }): Promise<JobResult> {
    const { job, outputPath, elapsedMs, encoder, hwFallback, ffprobePath } = params
    let sizeBytes = 0
    let actual = null as Awaited<ReturnType<typeof probeFile>> | null
    try {
      actual = ffprobePath ? await probeFile(ffprobePath, outputPath) : null
      if (actual) sizeBytes = actual.sizeBytes
    } catch (error) {
      this.deps.logger.warn('queue', `读取输出信息失败：${String(error)}`)
    }

    const sourceSize = job.media?.sizeBytes ?? 0
    const finalSize = sizeBytes || (actual?.sizeBytes ?? 0)
    return {
      outputPath,
      sizeBytes: finalSize,
      sourceSizeBytes: sourceSize,
      ratio: sourceSize > 0 ? finalSize / sourceSize : 0,
      elapsedMs,
      encoder,
      container: job.spec.container,
      width: actual?.video?.width ?? job.spec.video.width ?? job.media?.video?.width ?? null,
      height: actual?.video?.height ?? job.spec.video.height ?? job.media?.video?.height ?? null,
      frameRate: actual?.video?.frameRate ?? job.spec.video.frameRate ?? job.media?.video?.frameRate ?? null,
      videoBitrateKbps: actual?.video?.bitRate ? Math.round(actual.video.bitRate / 1000) : job.spec.video.bitrateKbps,
      audioBitrateKbps: actual?.audio?.bitRate ? Math.round(actual.audio.bitRate / 1000) : job.spec.audio.bitrateKbps,
      audioCodec: actual?.audio?.codec ?? (job.spec.audio.mode === 'none' ? null : job.spec.audio.codec),
      hwFallback,
      logPath: null
    }
  }
}
