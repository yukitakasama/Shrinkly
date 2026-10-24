/**
 * 用系统默认浏览器打开 WebGUI。
 *
 * 从 Electron 主进程里抽出来，便于单测：真实的打开动作（shell.openExternal /
 * 平台命令）通过参数注入，测试里可以用假的实现验证回退顺序与超时行为。
 *
 * 背景：默认浏览器可能是启动较慢的 Chromium 壳（本机默认浏览器就是 ego lite），
 * 4~5 秒等不到首页请求是常态，所以首轮等待放宽到 8 秒；回退只做一次，
 * 避免同一网址被开出多个标签页。
 */
import { join } from 'node:path'

export type LogLevel = 'info' | 'warn' | 'error'
export type LogFn = (level: LogLevel, message: string) => void

export interface OpenCommand {
  file: string
  args: string[]
}

export interface OpenInBrowserOptions {
  url: string
  log: LogFn
  /** Electron 的 shell.openExternal。 */
  openExternal: (url: string) => Promise<void>
  /** 同步执行平台命令；失败时抛错。 */
  run: (command: OpenCommand) => void
  /** 等待服务收到首页请求，返回是否在超时前收到。 */
  waitForHit: (timeoutMs: number) => Promise<boolean>
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** openExternal 之后的等待时间，默认 8000ms。 */
  primaryWaitMs?: number
  /** 回退命令之后的等待时间，默认 15000ms。 */
  fallbackWaitMs?: number
  /** openExternal 自身的最长等待时间，默认 3000ms。 */
  openExternalTimeoutMs?: number
}

/** 失败时给用户的手动访问提示。 */
export const MANUAL_HINT = '请从托盘「复制访问地址」手动打开（地址同时写在 %APPDATA%\\shrinkly\\runtime.json）'

/** 生成平台对应的打开命令；Windows 使用绝对路径，避免 PATH 被裁剪时找不到命令。 */
export function buildOpenCommands(platform: NodeJS.Platform, url: string, env: NodeJS.ProcessEnv = process.env): OpenCommand[] {
  if (platform === 'win32') {
    const systemRoot = env['SystemRoot'] ?? env['windir'] ?? 'C:\\Windows'
    return [
      { file: join(systemRoot, 'System32', 'rundll32.exe'), args: ['url.dll,FileProtocolHandler', url] },
      { file: join(systemRoot, 'System32', 'cmd.exe'), args: ['/c', 'start', '', url] }
    ]
  }
  if (platform === 'darwin') return [{ file: 'open', args: [url] }]
  return [{ file: 'xdg-open', args: [url] }]
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时 ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * 打开 WebGUI 并返回是否确认收到页面请求。
 *
 * 流程：openExternal → 等待首页请求；没等到时回退一次平台命令（Windows 先
 * rundll32，命令本身失败才继续下一条），再等一轮。只回退一次是为了不重复开标签页。
 */
export async function openInBrowser(options: OpenInBrowserOptions): Promise<boolean> {
  const { url, log, openExternal, run, waitForHit } = options
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const primaryWaitMs = options.primaryWaitMs ?? 8000
  const fallbackWaitMs = options.fallbackWaitMs ?? 15000
  const openExternalTimeoutMs = options.openExternalTimeoutMs ?? 3000

  if (env['SHRINKLY_NO_BROWSER'] === '1') {
    log('info', 'SHRINKLY_NO_BROWSER=1，跳过自动打开浏览器')
    return false
  }

  log('info', `请求系统默认浏览器打开 ${url}`)
  const startedAt = Date.now()

  try {
    await withTimeout(openExternal(url), openExternalTimeoutMs)
  } catch (error) {
    // 已经确定失败，直接回退，不再白等一轮。
    log('warn', `openExternal 失败或超时：${describe(error)}`)
    return tryFallbackCommands()
  }

  if (await waitForHit(primaryWaitMs)) {
    log('info', `已用系统默认浏览器打开 WebGUI（${Date.now() - startedAt}ms）`)
    return true
  }

  log('warn', `openExternal 后 ${primaryWaitMs}ms 内没有收到页面请求，尝试回退方式`)
  return tryFallbackCommands()

  async function tryFallbackCommands(): Promise<boolean> {
    for (const command of buildOpenCommands(platform, url, env)) {
      log('warn', `回退执行 ${command.file} ${command.args.join(' ')}`)
      try {
        run(command)
      } catch (error) {
        log('warn', `执行 ${command.file} 失败：${describe(error)}`)
        continue
      }
      if (await waitForHit(fallbackWaitMs)) {
        log('info', `已用系统默认浏览器打开 WebGUI（${command.file}，${Date.now() - startedAt}ms）`)
        return true
      }
      // 命令已成功交给系统，只是页面还没被请求：不再尝试下一条，避免重复开标签页。
      log('warn', `${command.file} 已执行，但 ${fallbackWaitMs}ms 内仍未收到页面请求`)
      break
    }
    log('error', `浏览器似乎没有打开。${MANUAL_HINT}`)
    return false
  }
}
