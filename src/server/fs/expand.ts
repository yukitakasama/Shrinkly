/**
 * 把用户提供的路径（文件 / 文件夹）展开成可导入的视频文件列表。
 *
 * 浏览器无法提供本地绝对路径，因此 WebGUI 通过服务端的文件浏览器选择路径，
 * 展开逻辑与扫描规则统一放在这里。
 */
import { readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'

export const MEDIA_EXTENSIONS = [
  '.mp4',
  '.mkv',
  '.webm',
  '.mov',
  '.avi',
  '.flv',
  '.wmv',
  '.m4v',
  '.ts',
  '.mpg',
  '.mpeg'
]

export function isMediaFile(filePath: string): boolean {
  return MEDIA_EXTENSIONS.includes(extname(filePath).toLowerCase())
}

export interface ExpandOptions {
  recursive?: boolean
  maxDepth?: number
  /** 最多返回的文件数量，防止误选整个磁盘拖垮界面。 */
  limit?: number
}

/** 递归扫描给定路径，返回视频文件绝对路径（不存在的路径会被静默跳过）。 */
export async function expandPaths(paths: string[], options: ExpandOptions = {}): Promise<string[]> {
  const { recursive = true, maxDepth = 6, limit = 2000 } = options
  const results: string[] = []
  const queue: Array<{ path: string; depth: number }> = paths.map((entry) => ({ path: entry, depth: 0 }))

  while (queue.length > 0 && results.length < limit) {
    const current = queue.shift()
    if (!current) break
    let info
    try {
      info = await stat(current.path)
    } catch {
      continue
    }
    if (info.isFile()) {
      if (isMediaFile(current.path)) results.push(current.path)
      continue
    }
    if (!info.isDirectory() || (current.depth >= maxDepth && recursive) || !recursive) continue
    try {
      const entries = await readdir(current.path, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 })
      }
    } catch {
      // 无权限目录直接跳过
    }
  }
  return results
}
