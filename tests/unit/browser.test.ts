import { describe, expect, it } from 'vitest'
import { buildOpenCommands, openInBrowser, type LogLevel, type OpenCommand } from '../../src/main/browser'

function setup(overrides: {
  hits?: boolean[]
  openExternal?: (url: string) => Promise<void>
  run?: (command: OpenCommand) => void
  env?: NodeJS.ProcessEnv
  openExternalTimeoutMs?: number
}) {
  const hits = [...(overrides.hits ?? [])]
  const logs: Array<{ level: LogLevel; message: string }> = []
  const commands: OpenCommand[] = []
  const waits: number[] = []
  let externalCalls = 0

  const result = openInBrowser({
    url: 'http://127.0.0.1:12345/?token=abc',
    platform: 'win32',
    env: overrides.env ?? { SystemRoot: 'C:\\Windows' },
    primaryWaitMs: 8000,
    fallbackWaitMs: 15000,
    openExternalTimeoutMs: overrides.openExternalTimeoutMs ?? 3000,
    openExternal: async (url) => {
      externalCalls += 1
      if (overrides.openExternal) return overrides.openExternal(url)
    },
    run: (command) => {
      commands.push(command)
      overrides.run?.(command)
    },
    waitForHit: async (timeoutMs) => {
      waits.push(timeoutMs)
      return hits.length > 0 ? (hits.shift() as boolean) : false
    },
    log: (level, message) => logs.push({ level, message })
  })

  return { result, logs, commands, waits, externalCalls: () => externalCalls }
}

describe('buildOpenCommands', () => {
  it('Windows 优先 rundll32，其次 cmd，且使用 SystemRoot 绝对路径', () => {
    const commands = buildOpenCommands('win32', 'http://127.0.0.1:1/?token=x', { SystemRoot: 'D:\\Windows' })
    expect(commands).toHaveLength(2)
    expect(commands[0].file).toBe('D:\\Windows\\System32\\rundll32.exe')
    expect(commands[0].args).toEqual(['url.dll,FileProtocolHandler', 'http://127.0.0.1:1/?token=x'])
    expect(commands[1].file).toBe('D:\\Windows\\System32\\cmd.exe')
    expect(commands[1].args).toEqual(['/c', 'start', '', 'http://127.0.0.1:1/?token=x'])
  })

  it('缺少 SystemRoot 时回退到 C:\\Windows', () => {
    const commands = buildOpenCommands('win32', 'http://127.0.0.1:1/', {})
    expect(commands[0].file).toBe('C:\\Windows\\System32\\rundll32.exe')
  })

  it('macOS 与 Linux 使用各自命令', () => {
    expect(buildOpenCommands('darwin', 'http://x/')).toEqual([{ file: 'open', args: ['http://x/'] }])
    expect(buildOpenCommands('linux', 'http://x/')).toEqual([{ file: 'xdg-open', args: ['http://x/'] }])
  })
})

describe('openInBrowser', () => {
  it('openExternal 生效时不执行任何回退命令', async () => {
    const { result, commands, logs, externalCalls } = setup({ hits: [true] })
    await expect(result).resolves.toBe(true)
    expect(externalCalls()).toBe(1)
    expect(commands).toEqual([])
    expect(logs.some((entry) => entry.level === 'info' && entry.message.includes('已用系统默认浏览器打开'))).toBe(true)
  })

  it('openExternal 抛错后用 rundll32 回退，命中即成功', async () => {
    const { result, commands, logs } = setup({
      hits: [true],
      openExternal: async () => {
        throw new Error('openExternal 不可用')
      }
    })
    await expect(result).resolves.toBe(true)
    expect(commands).toHaveLength(1)
    expect(commands[0].file).toContain('rundll32.exe')
    expect(logs.some((entry) => entry.level === 'warn' && entry.message.includes('openExternal 失败或超时'))).toBe(true)
  })

  it('openExternal 静默失效（未抛错、也没有请求）时仍回退一次', async () => {
    const { result, commands, logs } = setup({ hits: [false, true] })
    await expect(result).resolves.toBe(true)
    expect(commands.map((command) => command.file)).toEqual([expect.stringContaining('rundll32.exe')])
    expect(logs.some((entry) => entry.message.includes('没有收到页面请求，尝试回退方式'))).toBe(true)
  })

  it('回退命令执行成功但页面仍未被请求时，不再继续尝试下一条命令（避免重复开标签页）', async () => {
    const { result, commands } = setup({ hits: [false, false] })
    await expect(result).resolves.toBe(false)
    expect(commands.map((command) => command.file)).toEqual([expect.stringContaining('rundll32.exe')])
  })

  it('rundll32 无法启动时继续尝试 cmd', async () => {
    let firstRun = true
    const { result, commands } = setup({
      hits: [true],
      openExternal: async () => {
        throw new Error('不可用')
      },
      run: () => {
        if (firstRun) {
          firstRun = false
          throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
        }
      }
    })
    await expect(result).resolves.toBe(true)
    expect(commands).toHaveLength(2)
    expect(commands[1].file).toContain('cmd.exe')
  })

  it('openExternal 卡住时会超时并回退', async () => {
    const { result, commands } = setup({
      hits: [true],
      openExternalTimeoutMs: 10,
      openExternal: () => new Promise<void>(() => undefined)
    })
    await expect(result).resolves.toBe(true)
    expect(commands).toHaveLength(1)
  })

  it('SHRINKLY_NO_BROWSER=1 时直接跳过', async () => {
    const { result, commands, externalCalls, logs } = setup({ env: { SHRINKLY_NO_BROWSER: '1' } })
    await expect(result).resolves.toBe(false)
    expect(externalCalls()).toBe(0)
    expect(commands).toEqual([])
    expect(logs[0].message).toContain('SHRINKLY_NO_BROWSER=1')
  })

  it('超时等待时长按主等待 / 回退等待分别传入', async () => {
    const { result, waits } = setup({ hits: [false, true] })
    await expect(result).resolves.toBe(true)
    expect(waits).toEqual([8000, 15000])
  })
})
