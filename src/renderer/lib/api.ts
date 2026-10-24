/**
 * WebGUI 的 API 客户端：全部通过本地 HTTP 服务通信（不再有 preload / IPC）。
 *
 * 访问令牌从地址栏 `?token=` 读取一次后存入 sessionStorage，
 * 之后每个请求通过 `x-shrinkly-token` 头携带。
 */
import { TOKEN_HEADER, TOKEN_QUERY } from '../../shared/api'
import type {
  AddJobRequest,
  AppStatus,
  EstimateRequest,
  ExpandPathsRequest,
  FsListResponse,
  LogEntryPayload,
  MoveJobRequest,
  PreviewArgsRequest,
  PreviewArgsResult,
  UpdateJobRequest,
  ValidateRequest
} from '../../shared/api'
import type {
  AppSettings,
  EstimateResult,
  HardwareStatus,
  InstallProgress,
  JobRecord,
  JobSpec,
  MediaInfo,
  ValidationResult
} from '../../shared/types'

const TOKEN_STORAGE_KEY = 'shrinkly.token'

function resolveToken(): string {
  const fromQuery = new URLSearchParams(window.location.search).get(TOKEN_QUERY)
  if (fromQuery) {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, fromQuery)
    // 从地址栏抹掉 token，避免被截图 / 历史记录泄露；刷新时从 sessionStorage 恢复
    const url = new URL(window.location.href)
    url.searchParams.delete(TOKEN_QUERY)
    window.history.replaceState({}, '', url.toString())
    return fromQuery
  }
  return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? ''
}

export const apiToken = resolveToken()

export class ApiError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly code?: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    [TOKEN_HEADER]: apiToken,
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...((init.headers as Record<string, string>) ?? {})
  }
  const response = await fetch(path, { ...init, headers })
  const text = await response.text()
  let payload: unknown = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  }
  if (!response.ok) {
    const record = (payload ?? {}) as { error?: string; hint?: string; code?: string }
    throw new ApiError(record.error ?? `请求失败（HTTP ${response.status}）`, record.hint, record.code)
  }
  return payload as T
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

export interface EventHandlers {
  jobUpdate: (job: JobRecord) => void
  jobProgress: (payload: { id: string; progress: JobRecord['progress'] }) => void
  jobLog: (payload: { id: string; line: string }) => void
  log: (entry: LogEntryPayload) => void
  install: (progress: InstallProgress) => void
}

/** 建立 SSE 订阅，返回取消函数。 */
export function subscribeEvents(handlers: Partial<EventHandlers>): () => void {
  const source = new EventSource(`/api/events?${TOKEN_QUERY}=${encodeURIComponent(apiToken)}`)

  const bind = <K extends string, T>(type: K, handler: ((payload: T) => void) | undefined): void => {
    if (!handler) return
    source.addEventListener(type, (event) => {
      try {
        handler(JSON.parse((event as MessageEvent<string>).data) as T)
      } catch {
        // 忽略单条坏数据
      }
    })
  }

  bind('job-update', handlers.jobUpdate)
  bind('job-progress', handlers.jobProgress)
  bind('job-log', handlers.jobLog)
  bind('log', handlers.log)
  bind('install', handlers.install)

  return () => source.close()
}

export const api = {
  status: (): Promise<AppStatus> => request<AppStatus>('/api/status'),
  refreshFfmpeg: (): Promise<AppStatus> => post<AppStatus>('/api/ffmpeg/refresh'),
  setFfmpegPath: (ffmpegPath: string | null): Promise<AppStatus> => post<AppStatus>('/api/ffmpeg/path', { ffmpegPath }),
  installFfmpeg: (): Promise<AppStatus> => post<AppStatus>('/api/ffmpeg/install'),
  probeHardware: (): Promise<HardwareStatus> => post<HardwareStatus>('/api/hw/probe'),

  getSettings: (): Promise<AppSettings> => request<AppSettings>('/api/settings'),
  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    request<AppSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),

  probe: (filePath: string): Promise<MediaInfo> => post<MediaInfo>('/api/probe', { path: filePath }),
  estimate: (input: EstimateRequest): Promise<EstimateResult> => post<EstimateResult>('/api/estimate', input),
  validate: (payload: ValidateRequest): Promise<ValidationResult> => post<ValidationResult>('/api/validate', payload),
  previewArgs: (payload: PreviewArgsRequest): Promise<PreviewArgsResult> => post<PreviewArgsResult>('/api/preview-args', payload),

  listJobs: (): Promise<JobRecord[]> => request<JobRecord[]>('/api/jobs'),
  addJob: (payload: AddJobRequest): Promise<JobRecord> => post<JobRecord>('/api/jobs', payload),
  updateJob: (id: string, payload: UpdateJobRequest): Promise<JobRecord> =>
    request<JobRecord>(`/api/jobs/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  cancelJob: (id: string): Promise<{ ok: boolean }> => post(`/api/jobs/${id}/cancel`),
  moveJob: (id: string, payload: MoveJobRequest): Promise<{ ok: boolean }> => post(`/api/jobs/${id}/move`, payload),
  removeJob: (id: string): Promise<{ ok: boolean }> => request(`/api/jobs/${id}`, { method: 'DELETE' }),
  startQueue: (): Promise<{ ok: boolean }> => post('/api/queue/start'),
  cancelAll: (): Promise<{ ok: boolean }> => post('/api/queue/cancel-all'),
  clearFinished: (): Promise<{ ok: boolean }> => post('/api/queue/clear-finished'),

  listDirectory: (targetPath?: string, kinds: 'media' | 'exe' | 'all' = 'media'): Promise<FsListResponse> => {
    const params = new URLSearchParams()
    if (targetPath) params.set('path', targetPath)
    if (kinds !== 'media') params.set('kinds', kinds)
    const query = params.toString()
    return request<FsListResponse>(`/api/fs/list${query ? `?${query}` : ''}`)
  },
  expandPaths: (payload: ExpandPathsRequest): Promise<{ files: string[] }> => post('/api/fs/expand', payload),
  reveal: (targetPath: string): Promise<{ ok: boolean }> => post('/api/fs/reveal', { path: targetPath }),

  logs: (limit = 2000): Promise<LogEntryPayload[]> => request<LogEntryPayload[]>(`/api/logs?limit=${limit}`),
  logsExportUrl: (): string => `/api/logs/export?${TOKEN_QUERY}=${encodeURIComponent(apiToken)}`,

  shutdown: (): Promise<{ ok: boolean }> => post('/api/shutdown')
}

export type { JobSpec }
