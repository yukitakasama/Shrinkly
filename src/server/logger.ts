/**
 * 轻量文件日志：按大小轮转 + 内存环形缓冲，供「日志抽屉」实时展示与导出。
 *
 * 不引入 electron-log，避免额外依赖。
 */
import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  time: number
  level: LogLevel
  scope: string
  message: string
}

const MAX_BUFFER = 5000
const MAX_FILE_BYTES = 2 * 1024 * 1024

export class Logger {
  private readonly buffer: LogEntry[] = []
  private readonly listeners = new Set<(entry: LogEntry) => void>()
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly logDirectory: string) {}

  private get filePath(): string {
    return join(this.logDirectory, 'shrinkly.log')
  }

  info(scope: string, message: string): void {
    this.push('info', scope, message)
  }

  warn(scope: string, message: string): void {
    this.push('warn', scope, message)
  }

  error(scope: string, message: string): void {
    this.push('error', scope, message)
  }

  /** 最近若干条日志（默认全部缓冲）。 */
  recent(limit = MAX_BUFFER): LogEntry[] {
    return this.buffer.slice(-limit)
  }

  /** 订阅实时日志（渲染层推送）。 */
  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 导出为文本（供「导出日志」使用）。 */
  toText(): string {
    return this.buffer
      .map((entry) => `[${new Date(entry.time).toISOString()}] [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.message}`)
      .join('\n')
  }

  private push(level: LogLevel, scope: string, message: string): void {
    const entry: LogEntry = { time: Date.now(), level, scope, message }
    this.buffer.push(entry)
    if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER)
    for (const listener of this.listeners) {
      try {
        listener(entry)
      } catch {
        // 日志监听器异常不应影响主流程
      }
    }
    void this.append(entry)
  }

  private append(entry: LogEntry): Promise<void> {
    const line = `[${new Date(entry.time).toISOString()}] [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.message}\n`
    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(this.logDirectory, { recursive: true })
        await this.rotateIfNeeded()
        await appendFile(this.filePath, line, 'utf8')
      })
      .catch(() => undefined)
    return this.writeQueue
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const info = await stat(this.filePath)
      if (info.size > MAX_FILE_BYTES) {
        await unlink(`${this.filePath}.1`).catch(() => undefined)
        await rename(this.filePath, `${this.filePath}.1`)
      }
    } catch {
      // 文件不存在时无需轮转
    }
  }
}
