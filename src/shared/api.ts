/**
 * 本地 HTTP API 契约（浏览器 WebGUI ⇄ 本地服务）。
 *
 * 应用不再使用 Electron 原生窗口：双击 exe 后启动 127.0.0.1 上的本地服务，
 * 浏览器加载 WebGUI，所有操作通过下面的 REST + SSE 接口完成。
 */
import type {
  AppSettings,
  Capabilities,
  EstimateInput,
  EstimateResult,
  FfmpegStatus,
  InstallProgress,
  JobRecord,
  JobSpec,
  MediaInfo,
  ProgressInfo,
  ValidationResult
} from './types'

/** 所有接口都要求携带的鉴权头（值在启动时随机生成）。 */
export const TOKEN_HEADER = 'x-shrinkly-token'

/** 查询参数形式的 token（供 EventSource / 下载链接使用）。 */
export const TOKEN_QUERY = 'token'

export interface AppStatus {
  settings: AppSettings
  ffmpeg: FfmpegStatus
  capabilities: Capabilities | null
  /** 服务版本，便于排查浏览器缓存问题。 */
  version: string
  /** 当前输出目录等运行期信息可在此扩展。 */
  platform: string
}

/** 服务端内部状态（不含 version/platform，由路由层补全）。 */
export type ServerStatus = Omit<AppStatus, 'version' | 'platform'>

export interface PreviewArgsRequest {
  spec: JobSpec
  outputPath: string
}

export interface PreviewArgsResult {
  args: string[]
  command: string
}

export interface AddJobRequest {
  spec: JobSpec
  media: MediaInfo | null
  estimate: EstimateResult | null
}

export interface UpdateJobRequest {
  spec: JobSpec
  estimate: EstimateResult | null
}

export interface MoveJobRequest {
  delta: number
}

export interface ValidateRequest {
  spec: JobSpec
  context?: {
    sourceAudioCodec?: string | null
    sourceWidth?: number | null
    sourceHeight?: number | null
    outputFileName?: string | null
  }
}

export interface FsRoot {
  label: string
  path: string
}

export interface FsEntry {
  name: string
  path: string
  kind: 'dir' | 'file'
  sizeBytes: number
  modifiedAt: number
  /** 是否为可导入的视频文件。 */
  isMedia: boolean
}

export interface FsListResponse {
  path: string
  parent: string | null
  roots: FsRoot[]
  entries: FsEntry[]
}

export interface ExpandPathsRequest {
  paths: string[]
  /** 为 true 时递归扫描文件夹（默认 true）。 */
  recursive?: boolean
}

export interface LogEntryPayload {
  time: number
  level: 'info' | 'warn' | 'error'
  scope: string
  message: string
}

export interface ShutdownResponse {
  ok: boolean
}

/** SSE 事件负载。 */
export interface ServerEventMap {
  'job-update': JobRecord
  'job-progress': { id: string; progress: ProgressInfo }
  'job-log': { id: string; line: string }
  log: LogEntryPayload
  install: InstallProgress
}

export type ServerEventType = keyof ServerEventMap

export type ServerEvent = {
  [K in ServerEventType]: { type: K; data: ServerEventMap[K] }
}[ServerEventType]

/** 便于文档与测试引用的路由表。 */
export const API_ROUTES = {
  status: 'GET /api/status',
  ffmpegRefresh: 'POST /api/ffmpeg/refresh',
  ffmpegPath: 'POST /api/ffmpeg/path',
  ffmpegInstall: 'POST /api/ffmpeg/install',
  settingsGet: 'GET /api/settings',
  settingsPut: 'PUT /api/settings',
  probe: 'POST /api/probe',
  estimate: 'POST /api/estimate',
  validate: 'POST /api/validate',
  previewArgs: 'POST /api/preview-args',
  jobsList: 'GET /api/jobs',
  jobsAdd: 'POST /api/jobs',
  jobUpdate: 'PATCH /api/jobs/:id',
  jobCancel: 'POST /api/jobs/:id/cancel',
  jobMove: 'POST /api/jobs/:id/move',
  jobDelete: 'DELETE /api/jobs/:id',
  queueStart: 'POST /api/queue/start',
  queueCancelAll: 'POST /api/queue/cancel-all',
  queueClearFinished: 'POST /api/queue/clear-finished',
  fsList: 'GET /api/fs/list',
  fsExpand: 'POST /api/fs/expand',
  fsReveal: 'POST /api/fs/reveal',
  logs: 'GET /api/logs',
  logsExport: 'GET /api/logs/export',
  events: 'GET /api/events',
  shutdown: 'POST /api/shutdown'
} as const

export type EstimateRequest = EstimateInput
export type { AppSettings, Capabilities, EstimateResult, JobRecord, JobSpec, MediaInfo, ProgressInfo, ValidationResult }
