/**
 * REST API 路由实现（浏览器 WebGUI 的唯一入口）。
 *
 * 所有入参在服务端重新校验：浏览器传来的数据一律视为不可信。
 */
import { readdir, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { AppError } from '../ffmpeg/errors'
import { buildFfmpegArgs, formatCommandForDisplay } from '../ffmpeg/args'
import { probeFile } from '../ffmpeg/probe'
import { expandPaths, isMediaFile } from '../fs/expand'
import type { AppState } from '../state'
import { computeEstimate } from '../../shared/estimate'
import { jobSpecSchema, validateJobSpec } from '../../shared/validation'
import type {
  AddJobRequest,
  AppStatus,
  FsEntry,
  FsListResponse,
  FsRoot,
  MoveJobRequest,
  PreviewArgsRequest,
  PreviewArgsResult,
  UpdateJobRequest,
  ValidateRequest
} from '../../shared/api'
import type { EstimateInput, JobSpec } from '../../shared/types'
import { HttpError, Router, sendJson, type RouteContext } from './router'

export interface RouteDeps {
  state: AppState
  version: string
  /** 请求关闭应用（由 Electron 外壳注入）。 */
  requestShutdown: () => void
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, '请求体必须是 JSON 对象')
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, `参数 ${field} 必须是非空字符串`)
  }
  return value
}

function parseSpec(payload: unknown): JobSpec {
  const record = asRecord(payload)
  const parsed = jobSpecSchema.safeParse(record.spec)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw new HttpError(400, `任务参数不合法：${first.path.join('.')} ${first.message}`)
  }
  return parsed.data as JobSpec
}

/** 校验任务参数，失败返回 400 并带上中文原因。 */
function assertSpecValid(spec: JobSpec, context: Parameters<typeof validateJobSpec>[1] = {}): void {
  const validation = validateJobSpec(spec, context)
  if (!validation.ok) {
    const first = validation.errors[0]
    throw new HttpError(400, `${first.message}（${first.hint}）`)
  }
}

async function listRoots(): Promise<FsRoot[]> {
  if (process.platform === 'win32') {
    const roots: FsRoot[] = []
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('')) {
      const candidate = `${letter}:/`
      try {
        await stat(candidate)
        roots.push({ label: `${letter}: 盘`, path: candidate })
      } catch {
        // 盘符不存在
      }
    }
    if (roots.length === 0) roots.push({ label: '当前目录', path: process.cwd() })
    return roots
  }
  return [
    { label: '根目录', path: '/' },
    { label: '主目录', path: homedir() }
  ]
}

type ListKinds = 'media' | 'exe' | 'all'

async function listDirectory(targetPath: string, kinds: ListKinds = 'media'): Promise<FsListResponse> {
  const roots = await listRoots()
  const info = await stat(targetPath).catch(() => null)
  if (!info || !info.isDirectory()) {
    throw new HttpError(404, `目录不存在：${targetPath}`)
  }

  const entries: FsEntry[] = []
  try {
    const dirents = await readdir(targetPath, { withFileTypes: true })
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue
      const fullPath = join(targetPath, dirent.name)
      if (dirent.isDirectory()) {
        entries.push({ name: dirent.name, path: fullPath, kind: 'dir', sizeBytes: 0, modifiedAt: 0, isMedia: false })
        continue
      }
      if (!dirent.isFile()) continue
      const media = isMediaFile(fullPath)
      const executable = /\.exe$/i.test(dirent.name)
      const wanted = kinds === 'all' || (kinds === 'media' ? media : executable)
      if (!wanted) continue
      const fileInfo = await stat(fullPath).catch(() => null)
      entries.push({
        name: dirent.name,
        path: fullPath,
        kind: 'file',
        sizeBytes: fileInfo?.size ?? 0,
        modifiedAt: fileInfo?.mtimeMs ?? 0,
        isMedia: media
      })
    }
  } catch (error) {
    throw new HttpError(403, `无法读取目录：${targetPath}（${error instanceof Error ? error.message : String(error)}）`)
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })

  const parent = dirname(targetPath)
  return {
    path: targetPath,
    parent: parent === targetPath ? null : parent,
    roots,
    entries
  }
}

/** 用系统文件管理器定位文件或打开目录。 */
function revealInExplorer(targetPath: string): void {
  const info = { isDirectory: false }
  void stat(targetPath)
    .then((value) => {
      info.isDirectory = value.isDirectory()
      if (process.platform === 'win32') {
        if (info.isDirectory) spawn('explorer', [targetPath], { windowsHide: true, detached: true }).unref()
        else spawn('explorer', ['/select,', targetPath], { windowsHide: true, detached: true }).unref()
        return
      }
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
      spawn(opener, [info.isDirectory ? targetPath : dirname(targetPath)], { detached: true }).unref()
    })
    .catch(() => {
      throw new HttpError(404, '目标路径不存在')
    })
}

export function registerRoutes(router: Router, deps: RouteDeps): void {
  const { state } = deps
  const status = (): AppStatus => ({ ...state.getStatus(), version: deps.version, platform: process.platform })

  router.get('/api/health', () => ({ ok: true }), { public: true })

  router.get('/api/status', () => status())
  router.post('/api/ffmpeg/refresh', () => state.refreshFfmpeg())
  router.post('/api/ffmpeg/path', async ({ body }: RouteContext) => {
    const record = asRecord(body)
    const ffmpegPath = record.ffmpegPath === null ? null : requireString(record.ffmpegPath, 'ffmpegPath')
    return state.setCustomPath(ffmpegPath)
  })
  router.post('/api/ffmpeg/install', async () => state.installFfmpeg())

  router.get('/api/settings', () => state.settings.get())
  router.put('/api/settings', async ({ body }: RouteContext) => {
    const record = asRecord(body)
    return state.updateSettings(record as Parameters<typeof state.updateSettings>[0])
  })

  router.post('/api/probe', async ({ body }: RouteContext) => {
    const record = asRecord(body)
    const filePath = requireString(record.path, 'path')
    const ffprobePath = state.getFfprobePath()
    if (!ffprobePath) {
      throw new AppError({
        code: 'FFMPEG_MISSING',
        title: '未检测到 ffprobe',
        detail: '没有可用的 ffprobe，无法读取媒体信息。',
        hint: '请先在设置中安装或指定 ffmpeg 路径。'
      }).toJobError()
    }
    return probeFile(ffprobePath, filePath)
  })

  router.post('/api/estimate', async ({ body }: RouteContext) => {
    const input = asRecord(body) as unknown as EstimateInput
    if (!input || !input.media) throw new HttpError(400, '缺少 media 字段')
    return computeEstimate(input)
  })

  router.post('/api/validate', async ({ body }: RouteContext) => {
    const request = asRecord(body) as unknown as ValidateRequest
    const spec = parseSpec({ spec: request.spec })
    return validateJobSpec(spec, request.context ?? {})
  })

  router.post('/api/preview-args', async ({ body }: RouteContext) => {
    const request = asRecord(body) as unknown as PreviewArgsRequest
    const spec = parseSpec({ spec: request.spec })
    const outputPath = requireString(request.outputPath, 'outputPath')
    const args = buildFfmpegArgs({ spec, input: spec.inputPath, output: outputPath, includeProgress: false })
    const result: PreviewArgsResult = {
      args,
      command: formatCommandForDisplay([state.getFfmpegPath() ?? 'ffmpeg', ...args])
    }
    return result
  })

  router.get('/api/jobs', () => state.queue.list())

  router.post('/api/jobs', async ({ body }: RouteContext) => {
    const request = asRecord(body) as unknown as AddJobRequest
    const spec = parseSpec({ spec: request.spec })
    assertSpecValid(spec, {
      sourceAudioCodec: request.media?.audio?.codec ?? null,
      sourceWidth: request.media?.video?.width ?? null,
      sourceHeight: request.media?.video?.height ?? null
    })
    return state.queue.enqueue({ spec, media: request.media ?? null, estimate: request.estimate ?? null })
  })

  router.patch('/api/jobs/:id', async ({ params, body }: RouteContext) => {
    const request = asRecord(body) as unknown as UpdateJobRequest
    const spec = parseSpec({ spec: request.spec })
    assertSpecValid(spec, {})
    const updated = state.queue.updateSpec(params.id, spec, request.estimate ?? null)
    if (!updated) throw new HttpError(404, '任务不存在或正在运行')
    return updated
  })

  router.post('/api/jobs/:id/cancel', ({ params }: RouteContext) => {
    state.queue.cancel(params.id)
    return { ok: true }
  })

  router.post('/api/jobs/:id/move', ({ params, body }: RouteContext) => {
    const request = asRecord(body) as unknown as MoveJobRequest
    const delta = Math.trunc(Number(request.delta) || 0)
    state.queue.move(params.id, delta)
    return { ok: true }
  })

  router.delete('/api/jobs/:id', ({ params }: RouteContext) => {
    state.queue.remove(params.id)
    return { ok: true }
  })

  router.post('/api/queue/start', () => {
    state.queue.start()
    return { ok: true }
  })
  router.post('/api/queue/cancel-all', () => {
    state.queue.cancelAll()
    return { ok: true }
  })
  router.post('/api/queue/clear-finished', () => {
    state.queue.clearFinished()
    return { ok: true }
  })

  router.get('/api/fs/list', async ({ url }: RouteContext) => {
    const requested = url.searchParams.get('path')
    const rawKinds = url.searchParams.get('kinds')
    const kinds: ListKinds = rawKinds === 'exe' || rawKinds === 'all' ? rawKinds : 'media'
    const roots = await listRoots()
    const target = requested && requested.trim().length > 0 ? requested : (roots[0]?.path ?? process.cwd())
    return listDirectory(target, kinds)
  })

  router.post('/api/fs/expand', async ({ body }: RouteContext) => {
    const record = asRecord(body)
    const paths = Array.isArray(record.paths) ? record.paths.filter((item): item is string => typeof item === 'string') : []
    if (paths.length === 0) throw new HttpError(400, 'paths 不能为空')
    const recursive = record.recursive !== false
    return { files: await expandPaths(paths, { recursive }) }
  })

  router.post('/api/fs/reveal', async ({ body }: RouteContext) => {
    const record = asRecord(body)
    const target = requireString(record.path, 'path')
    const info = await stat(target).catch(() => null)
    if (!info) throw new HttpError(404, '目标路径不存在')
    revealInExplorer(target)
    return { ok: true }
  })

  router.get('/api/logs', ({ url }: RouteContext) => {
    const limit = Number(url.searchParams.get('limit') ?? '2000')
    return state.logger.recent(Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 5000) : 2000)
  })

  router.get('/api/logs/export', ({ res }: RouteContext) => {
    const body = state.logger.toText()
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="shrinkly-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.txt"`,
      'Content-Length': Buffer.byteLength(body)
    })
    res.end(body)
    return undefined
  })

  router.get('/api/events', ({ req, res, sse }: RouteContext) => {
    sse.attach(req, res)
    return undefined
  })

  router.post('/api/shutdown', () => {
    deps.requestShutdown()
    return { ok: true }
  })
}

/** 统一的错误 → HTTP 响应映射。 */
export function errorToResponse(error: unknown): { status: number; payload: { error: string; hint?: string; code?: string } } {
  if (error instanceof HttpError) {
    return { status: error.status, payload: { error: error.message, hint: error.hint } }
  }
  if (error instanceof AppError) {
    return { status: 400, payload: { error: `${error.title}：${error.detail}`, hint: error.hint, code: error.code } }
  }
  if (error && typeof error === 'object' && 'code' in error && 'title' in error) {
    const structured = error as { code: string; title: string; detail: string; hint: string }
    return { status: 400, payload: { error: `${structured.title}：${structured.detail}`, hint: structured.hint, code: structured.code } }
  }
  if (error instanceof Error) {
    return { status: 500, payload: { error: error.message } }
  }
  return { status: 500, payload: { error: '未知错误' } }
}

void sendJson
void basename
void extname
