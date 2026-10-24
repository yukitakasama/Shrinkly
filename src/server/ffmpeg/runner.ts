/**
 * ffmpeg 进程执行：`-progress` 解析、日志缓冲、取消（杀进程树）与卡死告警。
 *
 * 关键约束（PLAN §4.3）：
 * - 使用 spawn + 参数数组，**从不经过 shell**；
 * - 取消时杀整个进程树（Windows 用 taskkill /T /F）；
 * - 连续 60s 无进度只警告，不自动杀进程（避免误杀慢编码）。
 */
import { spawn } from 'node:child_process'
import type { ProgressInfo } from '../../shared/types'

const IS_WINDOWS = process.platform === 'win32'

export interface RunOptions {
  ffmpegPath: string
  args: string[]
  /** 源时长（秒），未知时进度只上报已处理时间。 */
  durationSec: number | null
  onProgress?: (progress: ProgressInfo) => void
  onLogLine?: (line: string, stream: 'stdout' | 'stderr') => void
  /** 无进度告警阈值。 */
  stallMs?: number
  /** 进度推送节流间隔。 */
  progressIntervalMs?: number
}

export interface RunOutcome {
  code: number | null
  stderrTail: string
  elapsedMs: number
  canceled: boolean
  timedOut: boolean
  spawnError: string | null
}

export interface RunHandle {
  promise: Promise<RunOutcome>
  cancel: () => void
}

/** 解析 `-progress` 输出中的 `out_time_us` / `out_time_ms`。 */
function parseTimeKey(key: string, value: string): number | null {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  if (key === 'out_time_us' || key === 'out_time_ms') return numeric / 1_000_000
  if (key === 'out_time') {
    const match = value.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/)
    if (!match) return null
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
  }
  return null
}

/** 启动 ffmpeg 并返回可取消的句柄。 */
export function runFfmpeg(options: RunOptions): RunHandle {
  const {
    ffmpegPath,
    args,
    durationSec,
    onProgress,
    onLogLine,
    stallMs = 60_000,
    progressIntervalMs = 250
  } = options

  const startedAt = Date.now()
  let canceled = false
  let timedOut = false
  let spawnError: string | null = null
  let settled = false
  let resolveOutcome: (outcome: RunOutcome) => void = () => undefined

  const stderrLines: string[] = []
  let stdoutBuffer = ''
  let stderrBuffer = ''

  let frame: number | null = null
  let fps: number | null = null
  let speed: number | null = null
  let bytes: number | null = null
  let outTimeSec = 0
  let lastEmit = 0
  let lastProgressAt = Date.now()
  let stallWarned = false

  const child = spawn(ffmpegPath, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !IS_WINDOWS
  })

  const emitProgress = (force: boolean): void => {
    if (!onProgress) return
    const now = Date.now()
    if (!force && now - lastEmit < progressIntervalMs) return
    lastEmit = now
    const percent =
      durationSec && durationSec > 0 ? Math.min(100, Math.max(0, (outTimeSec / durationSec) * 100)) : 0
    const etaSec =
      durationSec && speed && speed > 0 ? Math.max(0, (durationSec - outTimeSec) / speed) : null
    onProgress({
      percent: Number.isFinite(percent) ? Math.round(percent * 10) / 10 : 0,
      timeSec: Math.round(outTimeSec * 1000) / 1000,
      frame,
      fps,
      speed,
      etaSec: etaSec === null ? null : Math.round(etaSec),
      bytes,
      updatedAt: now
    })
  }

  const handleStdout = (line: string): void => {
    const index = line.indexOf('=')
    if (index <= 0) return
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    switch (key) {
      case 'frame':
        frame = Number(value) || 0
        break
      case 'fps':
        fps = value === 'N/A' ? null : Number(value)
        break
      case 'speed':
        speed = value.endsWith('x') ? Number(value.slice(0, -1)) : null
        break
      case 'total_size':
        bytes = Number(value) || 0
        break
      case 'out_time_us':
      case 'out_time_ms':
      case 'out_time': {
        const seconds = parseTimeKey(key, value)
        if (seconds !== null) outTimeSec = seconds
        break
      }
      case 'progress':
        lastProgressAt = Date.now()
        emitProgress(true)
        break
      default:
        break
    }
  }

  const handleStderr = (line: string): void => {
    if (!line.trim()) return
    stderrLines.push(line)
    if (stderrLines.length > 200) stderrLines.shift()
    lastProgressAt = Date.now()
    onLogLine?.(line, 'stderr')
  }

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) handleStdout(line)
  })
  child.stderr?.on('data', (chunk: string) => {
    stderrBuffer += chunk
    const lines = stderrBuffer.split(/\r?\n/)
    stderrBuffer = lines.pop() ?? ''
    for (const line of lines) handleStderr(line)
  })

  // 卡死检测：只告警不杀进程。
  const stallTimer = setInterval(() => {
    if (settled) return
    if (stallWarned) return
    if (Date.now() - lastProgressAt > stallMs) {
      stallWarned = true
      onLogLine?.(`[warn] 已 ${Math.round(stallMs / 1000)} 秒没有收到进度输出，编码可能非常慢或已卡住；不会自动中止。`, 'stderr')
    }
  }, 5000)

  const finish = (code: number | null): void => {
    if (settled) return
    settled = true
    clearInterval(stallTimer)
    if (stderrBuffer) handleStderr(stderrBuffer)
    resolveOutcome({
      code,
      stderrTail: stderrLines.join('\n'),
      elapsedMs: Date.now() - startedAt,
      canceled,
      timedOut,
      spawnError
    })
  }

  child.on('error', (error) => {
    spawnError = error.message
    finish(null)
  })
  child.on('close', (code) => finish(code))

  const killTree = (): void => {
    const pid = child.pid
    if (!pid) return
    if (IS_WINDOWS) {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
      killer.on('error', () => child.kill('SIGKILL'))
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  }

  const promise = new Promise<RunOutcome>((resolve) => {
    resolveOutcome = resolve
  })

  return {
    promise,
    cancel: (): void => {
      canceled = true
      killTree()
    }
  }
}
