/**
 * 子进程执行封装：参数数组传递，**从不经过 shell**，因此中文 / 空格 / emoji 路径安全。
 */
import { spawn } from 'node:child_process'

export interface CaptureResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  /** spawn 本身失败（例如文件不存在）时的错误信息。 */
  spawnError: string | null
}

export interface CaptureOptions {
  timeoutMs?: number
  /** 逐行回调 stderr（用于实时日志）。 */
  onStderrLine?: (line: string) => void
  /** 逐行回调 stdout（用于 -progress 解析）。 */
  onStdoutLine?: (line: string) => void
}

/** 运行进程并收集输出；超时会被强制结束并标记 `timedOut`。 */
export function runCapture(command: string, args: string[], options: CaptureOptions = {}): Promise<CaptureResult> {
  const { timeoutMs = 0, onStderrLine, onStdoutLine } = options
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let stdoutBuffer = ''
    let stderrBuffer = ''
    let timedOut = false
    let settled = false
    let spawnError: string | null = null

    let timer: NodeJS.Timeout | null = null
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)
    }

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (stdoutBuffer && onStdoutLine) onStdoutLine(stdoutBuffer)
      if (stderrBuffer && onStderrLine) onStderrLine(stderrBuffer)
      resolve({ stdout, stderr, code, timedOut, spawnError })
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      if (!onStdoutLine) return
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) onStdoutLine(line)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      if (!onStderrLine) return
      stderrBuffer += chunk
      const lines = stderrBuffer.split(/\r?\n/)
      stderrBuffer = lines.pop() ?? ''
      for (const line of lines) onStderrLine(line)
    })
    child.on('error', (error) => {
      spawnError = error.message
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}
