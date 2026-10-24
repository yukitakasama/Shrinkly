/**
 * 白名单 IPC 注册（PLAN §1.2 安全要求）。
 *
 * 所有入参都在主进程重新校验，渲染层无法直接触达 fs / child_process。
 */
import { readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AddJobPayload, AppStatus, PreviewArgsPayload, PreviewArgsResult, ValidatePayload } from '../../shared/ipc'
import type { AppSettings, EstimateInput, EstimateResult, JobSpec, MediaInfo, ValidationResult } from '../../shared/types'
import { computeEstimate } from '../../shared/estimate'
import { validateJobSpec } from '../../shared/validation'
import { buildFfmpegArgs, formatCommandForDisplay } from '../ffmpeg/args'
import { probeFile } from '../ffmpeg/probe'
import type { AppState } from '../state'

const MEDIA_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.flv', '.wmv', '.m4v', '.ts', '.mpg', '.mpeg']

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`参数 ${field} 必须是非空字符串`)
  }
  return value
}

/** 递归扫描文件夹中的视频文件。 */
async function expandPaths(paths: string[]): Promise<string[]> {
  const results: string[] = []
  const queue: Array<{ path: string; depth: number }> = paths.map((entry) => ({ path: entry, depth: 0 }))

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break
    let info
    try {
      info = await stat(current.path)
    } catch {
      continue
    }
    if (info.isFile()) {
      if (MEDIA_EXTENSIONS.includes(extname(current.path).toLowerCase())) results.push(current.path)
      continue
    }
    if (!info.isDirectory() || current.depth >= 6) continue
    try {
      const entries = await readdir(current.path, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 })
      }
    } catch {
      // 无权限的目录直接跳过
    }
  }
  return results
}

export function registerIpcHandlers(state: AppState, getWindow: () => BrowserWindow | null): void {
  const status = (): AppStatus => state.getStatus()

  ipcMain.handle(IPC.appStatus, () => status())
  ipcMain.handle(IPC.ffmpegRefresh, async () => state.refreshFfmpeg())
  ipcMain.handle(IPC.ffmpegSetPath, async (_event, ffmpegPath: unknown) => {
    if (ffmpegPath !== null && typeof ffmpegPath !== 'string') throw new Error('ffmpegPath 参数非法')
    return state.setCustomPath(ffmpegPath as string | null)
  })
  ipcMain.handle(IPC.ffmpegInstall, async () => state.installFfmpeg())

  ipcMain.handle(IPC.settingsGet, () => state.settings.get())
  ipcMain.handle(IPC.settingsUpdate, async (_event, patch: Partial<AppSettings>) => state.updateSettings(patch ?? {}))

  ipcMain.handle(IPC.dialogPickFiles, async () => {
    const window = getWindow()
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: '选择视频文件',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: '视频文件', extensions: MEDIA_EXTENSIONS.map((ext) => ext.slice(1)) }]
        })
      : await dialog.showOpenDialog({
          title: '选择视频文件',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: '视频文件', extensions: MEDIA_EXTENSIONS.map((ext) => ext.slice(1)) }]
        })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle(IPC.dialogPickDirectory, async () => {
    const window = getWindow()
    const result = window
      ? await dialog.showOpenDialog(window, { title: '选择输出目录', properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ title: '选择输出目录', properties: ['openDirectory', 'createDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.dialogPickExecutable, async () => {
    const window = getWindow()
    const options = {
      title: '选择 ffmpeg 可执行文件',
      properties: ['openFile'] as const,
      filters:
        process.platform === 'win32'
          ? [{ name: '可执行文件', extensions: ['exe'] }]
          : [{ name: '所有文件', extensions: ['*'] }]
    }
    const result = window
      ? await dialog.showOpenDialog(window, { ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.dialogOpenPath, async (_event, targetPath: unknown) => {
    const target = requireString(targetPath, 'path')
    const info = await stat(target).catch(() => null)
    if (!info) throw new Error('目标路径不存在')
    if (info.isDirectory()) {
      await shell.openPath(target)
    } else {
      shell.showItemInFolder(target)
    }
  })

  ipcMain.handle(IPC.fsExpandPaths, async (_event, paths: unknown) => {
    if (!Array.isArray(paths)) throw new Error('paths 必须是数组')
    const cleaned = paths.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    return expandPaths(cleaned)
  })

  ipcMain.handle(IPC.probeFile, async (_event, filePath: unknown): Promise<MediaInfo> => {
    const target = requireString(filePath, 'filePath')
    const ffprobePath = state.getFfprobePath()
    if (!ffprobePath) throw new Error('未检测到 ffprobe，无法读取媒体信息')
    return probeFile(ffprobePath, target)
  })

  ipcMain.handle(IPC.estimate, async (_event, input: EstimateInput) => {
    if (!input || typeof input !== 'object') throw new Error('估算参数非法')
    return computeEstimate(input)
  })

  ipcMain.handle(IPC.validateJob, async (_event, payload: ValidatePayload): Promise<ValidationResult> => {
    if (!payload || typeof payload !== 'object') throw new Error('校验参数非法')
    return validateJobSpec(payload.spec, payload.context ?? {})
  })

  ipcMain.handle(IPC.previewArgs, async (_event, payload: PreviewArgsPayload): Promise<PreviewArgsResult> => {
    if (!payload || typeof payload !== 'object') throw new Error('预览参数非法')
    const outputPath = requireString(payload.outputPath, 'outputPath')
    const args = buildFfmpegArgs({
      spec: payload.spec,
      input: payload.spec.inputPath,
      output: outputPath,
      includeProgress: false
    })
    return { args, command: formatCommandForDisplay([state.getFfmpegPath() ?? 'ffmpeg', ...args]) }
  })

  ipcMain.handle(IPC.queueAdd, async (_event, payload: AddJobPayload) => {
    if (!payload || typeof payload !== 'object' || !payload.spec) throw new Error('任务参数非法')
    const spec: JobSpec = payload.spec
    const validation = validateJobSpec(spec, {
      sourceAudioCodec: payload.media?.audio?.codec ?? null,
      sourceWidth: payload.media?.video?.width ?? null,
      sourceHeight: payload.media?.video?.height ?? null
    })
    if (!validation.ok) {
      const first = validation.errors[0]
      throw new Error(`${first.message}（${first.hint}）`)
    }
    return state.queue.enqueue({ spec, media: payload.media, estimate: payload.estimate })
  })

  ipcMain.handle(IPC.queueList, () => state.queue.list())
  ipcMain.handle(IPC.queueCancel, async (_event, id: unknown) => state.queue.cancel(requireString(id, 'id')))
  ipcMain.handle(IPC.queueCancelAll, async () => state.queue.cancelAll())
  ipcMain.handle(IPC.queueRemove, async (_event, id: unknown) => state.queue.remove(requireString(id, 'id')))
  ipcMain.handle(IPC.queueMove, async (_event, id: unknown, delta: unknown) => {
    state.queue.move(requireString(id, 'id'), Math.trunc(Number(delta) || 0))
  })
  ipcMain.handle(IPC.queueClearFinished, async () => state.queue.clearFinished())
  ipcMain.handle(IPC.queueStart, async () => state.queue.start())
  ipcMain.handle(IPC.queueUpdateSpec, async (_event, payload: { id: string; spec: JobSpec; estimate: EstimateResult | null }) => {
    if (!payload || typeof payload !== 'object') throw new Error('参数非法')
    const id = requireString(payload.id, 'id')
    const validation = validateJobSpec(payload.spec, {})
    if (!validation.ok) {
      const first = validation.errors[0]
      throw new Error(`${first.message}（${first.hint}）`)
    }
    state.queue.updateSpec(id, payload.spec, payload.estimate)
  })

  ipcMain.handle(IPC.logsRecent, () => state.logger.recent(2000))
  ipcMain.handle(IPC.logsExport, async () => {
    const window = getWindow()
    const options = {
      title: '导出日志',
      defaultPath: 'shrinkly-log.txt',
      filters: [{ name: '文本文件', extensions: ['txt', 'log'] }]
    }
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    const { writeFile } = await import('node:fs/promises')
    await writeFile(result.filePath, state.logger.toText(), 'utf8')
    return result.filePath
  })
}
