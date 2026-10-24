import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  AddJobPayload,
  AppStatus,
  LogEntryPayload,
  PreviewArgsPayload,
  PreviewArgsResult,
  ShrinklyApi,
  Unsubscribe,
  ValidatePayload
} from '../shared/ipc'
import type { AppSettings, EstimateInput, EstimateResult, InstallProgress, JobRecord, JobSpec, MediaInfo, ProgressInfo, ValidationResult } from '../shared/types'

function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const handler = (_event: unknown, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler as never)
  return () => {
    ipcRenderer.removeListener(channel, handler as never)
  }
}

const api: ShrinklyApi = {
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke(IPC.appStatus),
  refreshFfmpeg: (): Promise<AppStatus> => ipcRenderer.invoke(IPC.ffmpegRefresh),
  setFfmpegPath: (ffmpegPath: string | null): Promise<AppStatus> => ipcRenderer.invoke(IPC.ffmpegSetPath, ffmpegPath),
  installFfmpeg: (): Promise<AppStatus> => ipcRenderer.invoke(IPC.ffmpegInstall),

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsUpdate, patch),

  pickFiles: (): Promise<string[]> => ipcRenderer.invoke(IPC.dialogPickFiles),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC.dialogPickDirectory),
  pickExecutable: (): Promise<string | null> => ipcRenderer.invoke(IPC.dialogPickExecutable),
  openPath: (targetPath: string): Promise<void> => ipcRenderer.invoke(IPC.dialogOpenPath, targetPath),
  expandPaths: (paths: string[]): Promise<string[]> => ipcRenderer.invoke(IPC.fsExpandPaths, paths),

  probe: (filePath: string): Promise<MediaInfo> => ipcRenderer.invoke(IPC.probeFile, filePath),
  estimate: (input: EstimateInput): Promise<EstimateResult> => ipcRenderer.invoke(IPC.estimate, input),
  validate: (payload: ValidatePayload): Promise<ValidationResult> => ipcRenderer.invoke(IPC.validateJob, payload),
  previewArgs: (payload: PreviewArgsPayload): Promise<PreviewArgsResult> => ipcRenderer.invoke(IPC.previewArgs, payload),

  addJob: (payload: AddJobPayload): Promise<JobRecord> => ipcRenderer.invoke(IPC.queueAdd, payload),
  listJobs: (): Promise<JobRecord[]> => ipcRenderer.invoke(IPC.queueList),
  cancelJob: (id: string): Promise<void> => ipcRenderer.invoke(IPC.queueCancel, id),
  cancelAll: (): Promise<void> => ipcRenderer.invoke(IPC.queueCancelAll),
  removeJob: (id: string): Promise<void> => ipcRenderer.invoke(IPC.queueRemove, id),
  moveJob: (id: string, delta: number): Promise<void> => ipcRenderer.invoke(IPC.queueMove, id, delta),
  clearFinished: (): Promise<void> => ipcRenderer.invoke(IPC.queueClearFinished),
  startQueue: (): Promise<void> => ipcRenderer.invoke(IPC.queueStart),
  updateJobSpec: (payload: { id: string; spec: JobSpec; estimate: EstimateResult | null }): Promise<void> =>
    ipcRenderer.invoke(IPC.queueUpdateSpec, payload),

  recentLogs: (): Promise<LogEntryPayload[]> => ipcRenderer.invoke(IPC.logsRecent),
  exportLogs: (): Promise<string | null> => ipcRenderer.invoke(IPC.logsExport),

  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  onJobUpdate: (listener: (job: JobRecord) => void): Unsubscribe => subscribe<JobRecord>(IPC.eventJobUpdate, listener),
  onJobProgress: (listener: (payload: { id: string; progress: ProgressInfo }) => void): Unsubscribe =>
    subscribe<{ id: string; progress: ProgressInfo }>(IPC.eventJobProgress, listener),
  onJobLog: (listener: (payload: { id: string; line: string }) => void): Unsubscribe =>
    subscribe<{ id: string; line: string }>(IPC.eventJobLog, listener),
  onLogEntry: (listener: (entry: LogEntryPayload) => void): Unsubscribe => subscribe<LogEntryPayload>(IPC.eventLogEntry, listener),
  onInstallProgress: (listener: (progress: InstallProgress) => void): Unsubscribe =>
    subscribe<InstallProgress>(IPC.eventInstallProgress, listener)
}

contextBridge.exposeInMainWorld('shrinkly', api)

export type { ShrinklyApi }
