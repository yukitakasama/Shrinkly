/**
 * 应用运行期状态：配置、日志、ffmpeg 状态与任务队列的唯一持有者。
 *
 * 主进程 IPC 层只调用这里的方法，避免在多个文件里重复探测 ffmpeg。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { AppStatus } from '../shared/ipc'
import type { AppSettings, Capabilities, FfmpegStatus, InstallProgress } from '../shared/types'
import { probeCapabilities } from './ffmpeg/capabilities'
import { commonInstallCandidates, locateFfmpeg, verifyBinary, wingetInstallCandidates } from './ffmpeg/locator'
import { JobQueue } from './jobs/queue'
import { Logger } from './logger'
import { SettingsStore } from './settings'

export interface BroadcastHandlers {
  jobUpdate: (job: import('../shared/types').JobRecord) => void
  jobProgress: (payload: { id: string; progress: import('../shared/types').ProgressInfo }) => void
  jobLog: (payload: { id: string; line: string }) => void
  logEntry: (entry: { time: number; level: 'info' | 'warn' | 'error'; scope: string; message: string }) => void
  installProgress: (progress: InstallProgress) => void
}

export class AppState {
  readonly settings: SettingsStore
  readonly logger: Logger
  readonly queue: JobQueue
  private ffmpegStatus: FfmpegStatus = {
    state: 'missing',
    ffmpegPath: null,
    ffprobePath: null,
    version: null,
    source: 'none',
    message: '正在检测 ffmpeg…'
  }
  private capabilities: Capabilities | null = null
  private installRunning = false

  constructor(
    private readonly userDataDir: string,
    private readonly broadcast: BroadcastHandlers
  ) {
    this.settings = new SettingsStore(join(userDataDir, 'settings.json'))
    this.logger = new Logger(join(userDataDir, 'logs'))
    this.queue = new JobQueue({
      logger: this.logger,
      getFfmpegPath: () => this.getFfmpegPath(),
      getFfprobePath: () => this.getFfprobePath(),
      getCapabilities: () => this.capabilities,
      getConcurrency: () => this.settings.get().concurrency,
      onJobUpdate: (job) => broadcast.jobUpdate(job),
      onProgress: (id, progress) => broadcast.jobProgress({ id, progress }),
      onLog: (id, line) => broadcast.jobLog({ id, line })
    })
    this.logger.subscribe((entry) => broadcast.logEntry(entry))
  }

  async init(): Promise<void> {
    await this.settings.load()
    this.logger.info('app', 'Shrinkly 启动')
    await this.refreshFfmpeg()
  }

  getFfmpegPath(): string | null {
    return this.ffmpegStatus.state === 'ok' ? this.ffmpegStatus.ffmpegPath : null
  }

  getFfprobePath(): string | null {
    return this.ffmpegStatus.state === 'ok' ? this.ffmpegStatus.ffprobePath : null
  }

  getCapabilities(): Capabilities | null {
    return this.capabilities
  }

  getStatus(): AppStatus {
    return { settings: this.settings.get(), ffmpeg: this.ffmpegStatus, capabilities: this.capabilities }
  }

  /** 重新定位 ffmpeg，并（有效时）刷新编码器能力。 */
  async refreshFfmpeg(): Promise<AppStatus> {
    const settings = this.settings.get()
    this.ffmpegStatus = await locateFfmpeg({
      customPath: settings.ffmpegPath,
      extraCandidates: await commonInstallCandidates()
    })
    this.logger.info('ffmpeg', `定位结果：${this.ffmpegStatus.state} / ${this.ffmpegStatus.ffmpegPath ?? '无'}`)

    if (this.ffmpegStatus.state === 'ok' && this.ffmpegStatus.ffmpegPath) {
      try {
        this.capabilities = await probeCapabilities(
          this.ffmpegStatus.ffmpegPath,
          join(this.userDataDir, 'ffmpeg-capabilities.json')
        )
        this.capabilities = { ...this.capabilities, version: this.ffmpegStatus.version }
      } catch (error) {
        this.logger.warn('ffmpeg', `能力探测失败：${String(error)}`)
        this.capabilities = null
      }
    } else {
      this.capabilities = null
    }
    return this.getStatus()
  }

  /** 保存自定义 ffmpeg 路径并重新探测。 */
  async setCustomPath(ffmpegPath: string | null): Promise<AppStatus> {
    if (ffmpegPath) {
      const verified = await verifyBinary(ffmpegPath)
      if (!verified.ok) {
        throw new Error(`所选文件不是可用的 ffmpeg：${verified.raw.split('\n')[0] ?? ''}`)
      }
      this.logger.info('ffmpeg', `使用自定义路径 ${ffmpegPath}`)
    } else {
      this.logger.info('ffmpeg', '已清除自定义路径，回到自动探测')
    }
    await this.settings.update({ ffmpegPath })
    return this.refreshFfmpeg()
  }

  /** 通过 winget 安装 ffmpeg（流式输出日志）。 */
  async installFfmpeg(): Promise<AppStatus> {
    if (this.installRunning) {
      throw new Error('安装已在进行中')
    }
    this.installRunning = true
    const args = ['install', '--id', 'Gyan.FFmpeg', '-e', '--accept-source-agreements', '--accept-package-agreements']
    this.logger.info('ffmpeg', `开始 winget 安装：winget ${args.join(' ')}`)

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn('winget', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        let buffer = ''
        const handle = (chunk: string): void => {
          buffer += chunk
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const clean = line.replace(/\u001b\[[0-9;]*m/g, '').trim()
            if (!clean) continue
            this.logger.info('winget', clean)
            this.broadcast.installProgress({ phase: 'running', line: clean, exitCode: null })
          }
        }
        child.stdout?.setEncoding('utf8')
        child.stderr?.setEncoding('utf8')
        child.stdout?.on('data', handle)
        child.stderr?.on('data', handle)
        child.on('error', (error) => reject(error))
        child.on('close', (code) => resolve(code ?? 1))
      })

      if (exitCode !== 0) {
        this.broadcast.installProgress({
          phase: 'failed',
          line: `winget 退出码 ${exitCode}，安装未完成`,
          exitCode
        })
        this.logger.error('ffmpeg', `winget 安装失败，退出码 ${exitCode}`)
      } else {
        this.broadcast.installProgress({ phase: 'done', line: 'winget 安装完成，正在重新检测…', exitCode: 0 })
        this.logger.info('ffmpeg', 'winget 安装完成')
      }
    } catch (error) {
      this.broadcast.installProgress({
        phase: 'failed',
        line: `无法启动 winget：${error instanceof Error ? error.message : String(error)}`,
        exitCode: null
      })
      this.logger.error('ffmpeg', `无法启动 winget：${String(error)}`)
    } finally {
      this.installRunning = false
    }

    // winget 装好的 ffmpeg 往往不在当前进程 PATH 中，额外扫描安装目录。
    this.ffmpegStatus = await locateFfmpeg({
      customPath: this.settings.get().ffmpegPath,
      extraCandidates: [...(await wingetInstallCandidates()), ...(await commonInstallCandidates())]
    })
    if (this.ffmpegStatus.state === 'ok') {
      return this.refreshFfmpeg()
    }
    return this.getStatus()
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = await this.settings.update(patch)
    if (patch.concurrency !== undefined) this.queue.pump()
    if (patch.ffmpegPath !== undefined) await this.refreshFfmpeg()
    return next
  }
}
