/**
 * 输出路径处理：命名模板、非法字符清理、同名冲突策略、可写性与磁盘空间探测。
 *
 * 纯逻辑 + 少量 fs 调用；命名模板与净化函数可单独做单元测试。
 */
import { access, constants, mkdir, readdir, stat, statfs, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { ConflictStrategy } from '../../shared/types'

/** 命名模板可用的上下文。 */
export interface NameContext {
  /** 源文件主名（不含扩展名）。 */
  name: string
  /** 目标扩展名（不含点）。 */
  ext: string
  /** 视频编码名，例如 h264。 */
  codec: string
  /** 例如 1080p。 */
  resolution: string
  /** 例如 30fps。 */
  fps: string
  /** 质量档位。 */
  q: number | string
  /** 队列序号（从 1 开始）。 */
  index: number | string
  /** yyyyMMdd。 */
  date: string
  /** HHmmss。 */
  time: string
}

const WINDOWS_ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9'
])

/** 清理 Windows 非法字符、保留名与尾部空格 / 点。 */
export function sanitizeFileName(input: string): string {
  let name = input.replace(WINDOWS_ILLEGAL, '_')
  name = name.replace(/\s+/g, ' ').trim()
  name = name.replace(/[. ]+$/g, '')
  if (!name) name = 'output'
  const stem = name.split('.')[0].toLowerCase()
  if (RESERVED_NAMES.has(stem)) name = `_${name}`
  return name.slice(0, 180)
}

/** 渲染命名模板，未识别的占位符原样保留交给校验层报错。 */
export function renderNameTemplate(template: string, context: NameContext): string {
  const replaced = template.replace(/\{(\w+)\}/g, (whole, token: string) => {
    const key = token as keyof NameContext
    if (!(key in context)) return whole
    const value = context[key]
    return value === undefined || value === null ? '' : String(value)
  })
  return sanitizeFileName(replaced)
}

/** 拆分文件名与扩展名（无扩展名时 ext 为空串）。 */
export function splitExtension(fileName: string): { base: string; ext: string } {
  const ext = extname(fileName).replace(/^\./, '').toLowerCase()
  const base = ext ? fileName.slice(0, fileName.length - ext.length - 1) : fileName
  return { base, ext }
}

/** 由源路径推导默认命名上下文（不含 index / 质量等运行期信息）。 */
export function baseNameContext(inputPath: string, ext: string): NameContext {
  const fileName = basename(inputPath)
  const { base } = splitExtension(fileName)
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return {
    name: base,
    ext,
    codec: '',
    resolution: '',
    fps: '',
    q: '',
    index: 1,
    date: `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    time: `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  }
}

export interface ResolveOutputOptions {
  directory: string
  requestedName: string
  conflict: ConflictStrategy
  /** 绝不能与这些路径相同（通常是源文件）。 */
  avoidPaths?: string[]
}

export interface ResolvedOutput {
  path: string
  /** ask 表示需要界面询问用户。 */
  action: 'write' | 'skip' | 'ask'
  /** 自动重命名后的实际文件名。 */
  finalName: string
}

function normalizeForCompare(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase()
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** 解析最终输出路径并按冲突策略决定行为。 */
export async function resolveOutputPath(options: ResolveOutputOptions): Promise<ResolvedOutput> {
  const { directory, requestedName, conflict } = options
  const avoid = new Set((options.avoidPaths ?? []).map(normalizeForCompare))
  const { base, ext } = splitExtension(requestedName)
  const extension = ext ? `.${ext}` : ''

  const candidate = join(directory, `${sanitizeFileName(base)}${extension}`)
  const conflictsWithSource = avoid.has(normalizeForCompare(candidate))
  const taken = await exists(candidate)

  if (!taken && !conflictsWithSource) {
    return { path: candidate, action: 'write', finalName: basename(candidate) }
  }

  if (conflict === 'skip' && !conflictsWithSource) {
    return { path: candidate, action: 'skip', finalName: basename(candidate) }
  }

  if (conflict === 'ask' && !conflictsWithSource) {
    return { path: candidate, action: 'ask', finalName: basename(candidate) }
  }

  if (conflict === 'overwrite' && !conflictsWithSource) {
    return { path: candidate, action: 'write', finalName: basename(candidate) }
  }

  // rename（以及冲突来自源文件本身时）→ 追加序号。
  for (let index = 1; index < 10_000; index += 1) {
    const renamed = join(directory, `${sanitizeFileName(base)}_${index}${extension}`)
    if (avoid.has(normalizeForCompare(renamed))) continue
    if (!(await exists(renamed))) {
      return { path: renamed, action: 'write', finalName: basename(renamed) }
    }
  }
  return { path: candidate, action: 'skip', finalName: basename(candidate) }
}

/** 临时文件路径：`<name>.part.<ext>`（与最终文件同目录，保证 rename 原子性）。 */
export function temporaryPath(outputPath: string): string {
  const { base, ext } = splitExtension(basename(outputPath))
  const directory = dirname(outputPath)
  return join(directory, ext ? `${base}.part.${ext}` : `${base}.part`)
}

/** 判断文件名是否为本应用产生的临时文件。 */
export function isTemporaryFile(fileName: string): boolean {
  return /\.part(\.[^.]+)?$/i.test(fileName)
}

/** 创建目录（已存在则忽略）。 */
export async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
}

/** 目录是否可写（写入并删除探测文件）。 */
export async function isDirectoryWritable(directory: string): Promise<boolean> {
  const probe = join(directory, `.shrinkly-write-test-${process.pid}`)
  try {
    await ensureDirectory(directory)
    await (await import('node:fs/promises')).writeFile(probe, 'ok', 'utf8')
    await unlink(probe)
    return true
  } catch {
    return false
  }
}

/** 目标目录可用空间（字节），无法获取时返回 null。 */
export async function freeSpaceBytes(directory: string): Promise<number | null> {
  try {
    const stats = await statfs(directory)
    return stats.bavail * stats.bsize
  } catch {
    return null
  }
}

/** 清理本应用遗留的 `*.part.*` 临时文件（默认只清理 1 天前的）。 */
export async function cleanupStaleParts(directory: string, olderThanMs = 24 * 60 * 60 * 1000): Promise<string[]> {
  const removed: string[] = []
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    const now = Date.now()
    for (const entry of entries) {
      if (!entry.isFile() || !isTemporaryFile(entry.name)) continue
      const fullPath = join(directory, entry.name)
      try {
        const info = await stat(fullPath)
        if (now - info.mtimeMs < olderThanMs) continue
        await unlink(fullPath)
        removed.push(fullPath)
      } catch {
        // 单个文件失败不影响其他清理
      }
    }
  } catch {
    // 目录不存在
  }
  return removed
}
