/**
 * IPC 通道常量与载荷类型。
 *
 * 渲染层只能访问 preload 白名单暴露的方法；通道名集中在此，避免拼写漂移。
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

export const IPC = {
  appStatus: 'app:status',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  ffmpegRefresh: 'ffmpeg:refresh',
  ffmpegSetPath: 'ffmpeg:set-path',
  ffmpegInstall: 'ffmpeg:install',
  dialogPickFiles: 'dialog:pick-files',
  dialogPickDirectory: 'dialog:pick-directory',
  dialogOpenPath: 'dialog:open-path',
  dialogPickExecutable: 'dialog:pick-executable',
  fsExpandPaths: 'fs:expand-paths',
  probeFile: 'probe:file',
  estimate: 'estimate:compute',
  validateJob: 'job:validate',
  previewArgs: 'job:preview-args',
  queueAdd: 'queue:add',
  queueList: 'queue:list',
  queueCancel: 'queue:cancel',
  queueCancelAll: 'queue:cancel-all',
  queueRemove: 'queue:remove',
  queueMove: 'queue:move',
  queueClearFinished: 'queue:clear-finished',
  queueStart: 'queue:start',
  queueUpdateSpec: 'queue:update-spec',
  logsRecent: 'log:recent',
  logsExport: 'log:export',
  eventJobUpdate: 'evt:job-update',
  eventJobProgress: 'evt:job-progress',
  eventJobLog: 'evt:job-log',
  eventLogEntry: 'evt:log-entry',
  eventInstallProgress: 'evt:install-progress'
} as const

export interface AppStatus {
  settings: AppSettings
  ffmpeg: FfmpegStatus
  capabilities: Capabilities | null
}

export interface PreviewArgsPayload {
  spec: JobSpec
  /** 预览用的输出路径；不需要真实存在。 */
  outputPath: string
}

export interface PreviewArgsResult {
  args: string[]
  command: string
}

export interface AddJobPayload {
  spec: JobSpec
  media: MediaInfo | null
  estimate: EstimateResult | null
}

export interface ValidatePayload {
  spec: JobSpec
  context?: {
    sourceAudioCodec?: string | null
    sourceWidth?: number | null
    sourceHeight?: number | null
    outputFileName?: string | null
  }
}

export interface LogEntryPayload {
  time: number
  level: 'info' | 'warn' | 'error'
  scope: string
  message: string
}

export type Unsubscribe = () => void

/** preload 通过 contextBridge 暴露给渲染层的完整 API。 */
export interface ShrinklyApi {
  getStatus: () => Promise<AppStatus>
  refreshFfmpeg: () => Promise<AppStatus>
  setFfmpegPath: (ffmpegPath: string | null) => Promise<AppStatus>
  installFfmpeg: () => Promise<AppStatus>

  getSettings: () => Promise<AppSettings>
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>

  pickFiles: () => Promise<string[]>
  pickDirectory: () => Promise<string | null>
  pickExecutable: () => Promise<string | null>
  openPath: (targetPath: string) => Promise<void>
  /** 展开拖入的路径：文件夹递归扫描常见视频扩展名。 */
  expandPaths: (paths: string[]) => Promise<string[]>

  probe: (filePath: string) => Promise<MediaInfo>
  estimate: (input: EstimateInput) => Promise<EstimateResult>
  validate: (payload: ValidatePayload) => Promise<ValidationResult>
  previewArgs: (payload: PreviewArgsPayload) => Promise<PreviewArgsResult>

  addJob: (payload: AddJobPayload) => Promise<JobRecord>
  listJobs: () => Promise<JobRecord[]>
  cancelJob: (id: string) => Promise<void>
  cancelAll: () => Promise<void>
  removeJob: (id: string) => Promise<void>
  moveJob: (id: string, delta: number) => Promise<void>
  clearFinished: () => Promise<void>
  startQueue: () => Promise<void>
  updateJobSpec: (payload: { id: string; spec: JobSpec; estimate: EstimateResult | null }) => Promise<void>

  recentLogs: () => Promise<LogEntryPayload[]>
  exportLogs: () => Promise<string | null>

  /** Electron 32+ 中拖拽文件拿真实路径的唯一途径。 */
  getPathForFile: (file: File) => string

  onJobUpdate: (listener: (job: JobRecord) => void) => Unsubscribe
  onJobProgress: (listener: (payload: { id: string; progress: ProgressInfo }) => void) => Unsubscribe
  onJobLog: (listener: (payload: { id: string; line: string }) => void) => Unsubscribe
  onLogEntry: (listener: (entry: LogEntryPayload) => void) => Unsubscribe
  onInstallProgress: (listener: (progress: InstallProgress) => void) => Unsubscribe
}
