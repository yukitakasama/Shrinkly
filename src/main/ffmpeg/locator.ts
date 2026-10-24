/**
 * ffmpeg / ffprobe 定位与版本校验（PLAN §4.1）。
 *
 * 查找顺序：设置中的自定义路径 → 系统 PATH。找不到时返回 `missing`，
 * 由 UI 提供 winget 安装或手动选择。
 */
import { access, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FfmpegStatus } from '../../shared/types'
import { runCapture } from './exec'

const EXE = process.platform === 'win32' ? '.exe' : ''

function siblingFfprobe(ffmpegPath: string): string {
  return join(dirname(ffmpegPath), `ffprobe${EXE}`)
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

/** 从 `ffmpeg -version` 输出中提取版本号。 */
export function parseVersion(stdout: string): string | null {
  const match = stdout.match(/version\s+(\S+)/i)
  return match ? match[1] : null
}

/** 校验某个可执行文件可用，并返回版本号。 */
export async function verifyBinary(binaryPath: string): Promise<{ ok: boolean; version: string | null; raw: string }> {
  const result = await runCapture(binaryPath, ['-version'], { timeoutMs: 8000 })
  if (result.spawnError || result.timedOut) {
    return { ok: false, version: null, raw: result.spawnError ?? '执行超时' }
  }
  if (result.code !== 0) {
    return { ok: false, version: null, raw: result.stderr }
  }
  return { ok: true, version: parseVersion(result.stdout), raw: result.stdout }
}

/** 在 PATH 中查找可执行文件（Windows 使用 where，POSIX 使用 which）。 */
export async function findOnPath(name: string): Promise<string | null> {
  const command = process.platform === 'win32' ? 'where' : 'which'
  const result = await runCapture(command, [name], { timeoutMs: 6000 })
  if (result.code !== 0 || !result.stdout.trim()) return null
  const first = result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0)
  return first ?? null
}

/** winget 安装后可能出现的位置（用于安装完成后刷新 PATH 之外的兜底查找）。 */
export async function wingetInstallCandidates(): Promise<string[]> {
  const candidates: string[] = []
  const localAppData = process.env['LOCALAPPDATA']
  if (!localAppData) return candidates

  const links = join(localAppData, 'Microsoft', 'WinGet', 'Links', `ffmpeg${EXE}`)
  if (await exists(links)) candidates.push(links)

  const packagesRoot = join(localAppData, 'Microsoft', 'WinGet', 'Packages')
  try {
    const entries = await readdir(packagesRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.toLowerCase().startsWith('gyan.ffmpeg')) continue
      const packageRoot = join(packagesRoot, entry.name)
      try {
        const children = await readdir(packageRoot, { withFileTypes: true })
        for (const child of children) {
          if (!child.isDirectory()) continue
          const bin = join(packageRoot, child.name, 'bin', `ffmpeg${EXE}`)
          if (await exists(bin)) candidates.push(bin)
        }
      } catch {
        // 忽略无法读取的目录
      }
    }
  } catch {
    // 没有 winget 目录
  }
  return candidates
}


/**
 * 扫描常见安装位置（PATH 之外）：
 * - winget 的 Links / Packages 目录；
 * - `C:\ffmpeg`、`D:\ffmpeg` 及其版本化子目录；
 * - Program Files / Chocolatey 的 bin。
 *
 * 目的：用户把 ffmpeg 解压到固定目录却没有加 PATH 时也能自动发现。
 */
export async function commonInstallCandidates(): Promise<string[]> {
  const found: string[] = []
  found.push(...(await wingetInstallCandidates()))

  const roots = ['C:/ffmpeg', 'D:/ffmpeg', 'E:/ffmpeg']
  const programFiles = process.env['ProgramFiles']
  if (programFiles) roots.push(join(programFiles, 'ffmpeg'))
  const chocolateyBin = process.env['ProgramData'] ? join(process.env['ProgramData'], 'chocolatey', 'bin') : null

  for (const root of roots) {
    const direct = join(root, 'bin', `ffmpeg${EXE}`)
    if (await exists(direct)) found.push(direct)
    try {
      const entries = await readdir(root, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const candidate = join(root, entry.name, 'bin', `ffmpeg${EXE}`)
        if (await exists(candidate)) found.push(candidate)
      }
    } catch {
      // 目录不存在，跳过
    }
  }

  if (chocolateyBin) {
    const shim = join(chocolateyBin, `ffmpeg${EXE}`)
    if (await exists(shim)) found.push(shim)
  }

  return found
}

export interface LocateOptions {
  /** 设置中的自定义 ffmpeg 路径。 */
  customPath?: string | null
  /** 额外的候选路径（例如 winget 安装目录）。 */
  extraCandidates?: string[]
}

/** 定位 ffmpeg，返回带有可读消息的状态。 */
export async function locateFfmpeg(options: LocateOptions = {}): Promise<FfmpegStatus> {
  const customPath = options.customPath?.trim() || null

  if (customPath) {
    if (!(await exists(customPath))) {
      return {
        state: 'invalid',
        ffmpegPath: customPath,
        ffprobePath: null,
        version: null,
        source: 'custom',
        message: `自定义路径不存在：${customPath}`
      }
    }
    const verified = await verifyBinary(customPath)
    if (!verified.ok) {
      return {
        state: 'invalid',
        ffmpegPath: customPath,
        ffprobePath: null,
        version: null,
        source: 'custom',
        message: '自定义路径不是可用的 ffmpeg（-version 执行失败）'
      }
    }
    const ffprobe = siblingFfprobe(customPath)
    const ffprobeOk = (await exists(ffprobe)) || (await findOnPath('ffprobe'))
    return {
      state: 'ok',
      ffmpegPath: customPath,
      ffprobePath: (await exists(ffprobe)) ? ffprobe : await findOnPath('ffprobe'),
      version: verified.version,
      source: 'custom',
      message: ffprobeOk ? '已使用自定义 ffmpeg' : '未找到配套的 ffprobe（读取媒体信息将不可用）'
    }
  }

  const candidates = [...(options.extraCandidates ?? []), ...(await commonInstallCandidates())]
  for (const candidate of candidates) {
    if (!(await exists(candidate))) continue
    const verified = await verifyBinary(candidate)
    if (!verified.ok) continue
    return {
      state: 'ok',
      ffmpegPath: candidate,
      ffprobePath: (await exists(siblingFfprobe(candidate))) ? siblingFfprobe(candidate) : await findOnPath('ffprobe'),
      version: verified.version,
      source: 'path',
      message: `已在常用安装目录中找到 ffmpeg：${candidate}`
    }
  }

  const onPath = await findOnPath('ffmpeg')
  if (onPath) {
    const verified = await verifyBinary(onPath)
    if (verified.ok) {
      const ffprobe = (await exists(siblingFfprobe(onPath))) ? siblingFfprobe(onPath) : await findOnPath('ffprobe')
      return {
        state: 'ok',
        ffmpegPath: onPath,
        ffprobePath: ffprobe,
        version: verified.version,
        source: 'path',
        message: '已找到 ffmpeg'
      }
    }
    return {
      state: 'invalid',
      ffmpegPath: onPath,
      ffprobePath: null,
      version: null,
      source: 'path',
      message: 'PATH 中的 ffmpeg 无法执行（可能文件损坏）'
    }
  }

  return {
    state: 'missing',
    ffmpegPath: null,
    ffprobePath: null,
    version: null,
    source: 'none',
    message: '未检测到 ffmpeg，请安装后再试'
  }
}

/** 读取文件 mtime，用于能力缓存失效判定。 */
export async function fileMtime(filePath: string): Promise<number | null> {
  try {
    const info = await stat(filePath)
    return info.mtimeMs
  } catch {
    return null
  }
}
