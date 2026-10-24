/**
 * 渲染层唯一状态源（Zustand）。
 *
 * 约定：所有与主进程的交互都通过 `window.shrinkly`；store 只保存 UI 状态与派生结果。
 */
import { create } from 'zustand'
import type { AppStatus, LogEntryPayload } from '../shared/ipc'
import type {
  AudioCodec,
  AudioMode,
  ContainerFormat,
  EstimateResult,
  JobRecord,
  ValidationResult,
  VideoCodec
} from '../shared/types'
import { buildJobSpec, deriveTargets } from './lib/spec'

export type Mode = 'simple' | 'advanced'

export interface Toast {
  kind: 'info' | 'error' | 'success'
  message: string
}

interface AppStore {
  status: AppStatus | null
  jobs: JobRecord[]
  selectedId: string | null
  mode: Mode
  quality: number
  targetEnabled: boolean
  targetMB: number
  container: ContainerFormat
  videoCodec: VideoCodec
  audioCodec: AudioCodec
  audioMode: AudioMode
  estimate: EstimateResult | null
  validation: ValidationResult | null
  command: string
  editing: boolean
  importing: boolean
  toast: Toast | null
  logs: LogEntryPayload[]

  init: () => Promise<void>
  refreshJobs: () => Promise<void>
  setMode: (mode: Mode) => void
  selectJob: (id: string | null) => void
  setToast: (toast: Toast | null) => void
  setQuality: (quality: number) => void
  setTarget: (enabled: boolean, mb?: number) => void
  setContainer: (container: ContainerFormat) => void
  setVideoCodec: (codec: VideoCodec) => void
  setAudioCodec: (codec: AudioCodec) => void
  setAudioMode: (mode: AudioMode) => void
  importPaths: (paths: string[]) => Promise<void>
  refreshEditor: () => Promise<void>
  startQueue: () => Promise<void>
  cancelJob: (id: string) => Promise<void>
  cancelAll: () => Promise<void>
  removeJob: (id: string) => Promise<void>
  moveJob: (id: string, delta: number) => Promise<void>
  clearFinished: () => Promise<void>
  updateSettings: (patch: Partial<NonNullable<AppStatus['settings']>>) => Promise<void>
  setFfmpegPath: (ffmpegPath: string | null) => Promise<void>
  installFfmpeg: () => Promise<void>
}

const selectedJob = (state: Pick<AppStore, 'jobs' | 'selectedId'>): JobRecord | null =>
  state.jobs.find((job) => job.id === state.selectedId) ?? null

/** 切换选中任务时，把该任务的参数同步到编辑面板。 */
function editorFieldsFor(job: JobRecord | null): Partial<AppStore> {
  if (!job) return {}
  return {
    container: job.spec.container,
    videoCodec: job.spec.video.codec,
    audioCodec: job.spec.audio.codec,
    audioMode: job.spec.audio.mode,
    quality: job.estimate?.quality ?? 60,
    targetEnabled: job.estimate?.targetSizeMB !== null && job.estimate?.targetSizeMB !== undefined,
    targetMB: job.estimate?.targetSizeMB ?? 50
  }
}

export const useAppStore = create<AppStore>((set, get) => ({
  status: null,
  jobs: [],
  selectedId: null,
  mode: 'simple',
  quality: 60,
  targetEnabled: false,
  targetMB: 50,
  container: 'mp4',
  videoCodec: 'h264',
  audioCodec: 'aac',
  audioMode: 'encode',
  estimate: null,
  validation: null,
  command: '',
  editing: false,
  importing: false,
  toast: null,
  logs: [],

  async init() {
    const status = await window.shrinkly.getStatus()
    set({ status, quality: status.settings.defaultQuality })
    await get().refreshJobs()

    const recent = await window.shrinkly.recentLogs()
    set({ logs: recent.slice(-500) })

    window.shrinkly.onJobUpdate((job) => {
      set((state) => {
        const exists = state.jobs.some((item) => item.id === job.id)
        const jobs = exists ? state.jobs.map((item) => (item.id === job.id ? job : item)) : [...state.jobs, job]
        jobs.sort((a, b) => a.order - b.order)
        const nextState: Partial<AppStore> = { jobs }
        if (state.selectedId === null) nextState.selectedId = job.id
        return nextState
      })
      if (job.id === get().selectedId) void get().refreshEditor()
    })

    window.shrinkly.onJobProgress(({ id, progress }) => {
      set((state) => ({
        jobs: state.jobs.map((job) => (job.id === id ? { ...job, progress } : job))
      }))
    })

    window.shrinkly.onLogEntry((entry) => {
      set((state) => ({ logs: [...state.logs.slice(-1500), entry] }))
    })

    window.shrinkly.onJobLog(({ id, line }) => {
      // 任务日志直接并入全局日志抽屉，带文件名前缀便于搜索。
      set((state) => ({
        logs: [...state.logs.slice(-1500), { time: Date.now(), level: 'info', scope: id.slice(0, 8), message: line }]
      }))
    })
  },

  async refreshJobs() {
    const jobs = await window.shrinkly.listJobs()
    const currentId =
      get().selectedId && jobs.some((job) => job.id === get().selectedId) ? get().selectedId : (jobs[0]?.id ?? null)
    const job = jobs.find((item) => item.id === currentId) ?? null
    set({ jobs, selectedId: currentId, ...editorFieldsFor(job) })
    if (currentId) await get().refreshEditor()
  },

  setMode(mode) {
    set({ mode })
  },

  selectJob(id) {
    const job = get().jobs.find((item) => item.id === id) ?? null
    set({ selectedId: id, ...editorFieldsFor(job) })
    void get().refreshEditor()
  },

  setToast(toast) {
    set({ toast })
  },

  setQuality(quality) {
    set({ quality })
    void get().refreshEditor()
  },

  setTarget(enabled, mb) {
    set({ targetEnabled: enabled, ...(mb !== undefined ? { targetMB: mb } : {}) })
    void get().refreshEditor()
  },

  setContainer(container) {
    set({ container })
    void get().refreshEditor()
  },

  setVideoCodec(videoCodec) {
    set({ videoCodec })
    void get().refreshEditor()
  },

  setAudioCodec(audioCodec) {
    set({ audioCodec })
    void get().refreshEditor()
  },

  setAudioMode(audioMode) {
    set({ audioMode })
    void get().refreshEditor()
  },

  async importPaths(paths) {
    if (paths.length === 0) return
    set({ importing: true })
    try {
      const files = await window.shrinkly.expandPaths(paths)
      if (files.length === 0) {
        set({ toast: { kind: 'error', message: '没有找到可导入的视频文件' } })
        return
      }
      const status = get().status
      const settings = status?.settings
      let added = 0
      for (const filePath of files) {
        try {
          const media = await window.shrinkly.probe(filePath)
          const targets = deriveTargets(media)
          const estimate = await window.shrinkly.estimate({
            media,
            quality: settings?.defaultQuality ?? 60,
            videoCodec: targets.videoCodec,
            container: targets.container,
            audioCodec: targets.audioCodec,
            audioMode: targets.audioMode,
            targetSizeMB: null,
            hwAccel: settings?.hwAccel ?? false
          })
          if (!estimate.ok) {
            set({ toast: { kind: 'error', message: `${media.fileName}：${estimate.error?.title ?? '无法估算'}` } })
            continue
          }
          const spec = buildJobSpec({
            media,
            estimate,
            audioMode: targets.audioMode,
            audioCodec: targets.audioCodec,
            outputDirectory: settings?.outputDirectory ?? null,
            nameTemplate: settings?.nameTemplate ?? '{name}_compressed.{ext}',
            conflict: settings?.defaultConflict ?? 'rename',
            hwAccel: settings?.hwAccel ?? false
          })
          await window.shrinkly.addJob({ spec, media, estimate })
          added += 1
        } catch (error) {
          set({ toast: { kind: 'error', message: `${filePath}：${error instanceof Error ? error.message : String(error)}` } })
        }
      }
      await get().refreshJobs()
      if (added > 0) {
        set({ toast: { kind: 'success', message: `已加入 ${added} 个任务，确认参数后点「开始转换」` } })
        await get().refreshEditor()
      }
    } finally {
      set({ importing: false })
    }
  },

  /** 重算当前选中任务的估算、校验与命令预览，并把参数回写到队列。 */
  async refreshEditor() {
    const state = get()
    const job = selectedJob(state)
    if (!job || !job.media) {
      set({ estimate: null, validation: null, command: '' })
      return
    }
    const media = job.media
    const settings = state.status?.settings
    const container = state.container
    const videoCodec = state.videoCodec
    const audioCodec = state.audioCodec
    const audioMode = state.audioMode

    set({ editing: true })
    try {
      const estimate = await window.shrinkly.estimate({
        media,
        quality: state.quality,
        videoCodec,
        container,
        audioCodec,
        audioMode,
        targetSizeMB: state.targetEnabled ? state.targetMB : null,
        hwAccel: settings?.hwAccel ?? false
      })

      if (!estimate.ok) {
        set({ estimate, validation: null, command: '' })
        return
      }

      const spec = buildJobSpec({
        media,
        estimate,
        audioMode,
        audioCodec,
        outputDirectory: settings?.outputDirectory ?? null,
        nameTemplate: settings?.nameTemplate ?? '{name}_compressed.{ext}',
        conflict: settings?.defaultConflict ?? 'rename',
        hwAccel: settings?.hwAccel ?? false
      })

      const validation = await window.shrinkly.validate({
        spec,
        context: {
          sourceAudioCodec: media.audio?.codec ?? null,
          sourceWidth: media.video?.width ?? null,
          sourceHeight: media.video?.height ?? null
        }
      })

      const preview = await window.shrinkly.previewArgs({
        spec,
        outputPath: `${media.path.replace(/\.[^.]+$/, '')}_compressed.${estimate.container}`
      })

      set({ estimate, validation, command: preview.command })

      if (validation.ok && (job.status === 'queued' || job.status === 'preparing')) {
        await window.shrinkly.updateJobSpec({ id: job.id, spec, estimate })
      }
    } catch (error) {
      set({ toast: { kind: 'error', message: error instanceof Error ? error.message : String(error) } })
    } finally {
      set({ editing: false })
    }
  },

  async startQueue() {
    const job = selectedJob(get())
    if (job && (job.status === 'queued' || job.status === 'preparing')) {
      await get().refreshEditor()
    }
    await window.shrinkly.startQueue()
    await get().refreshJobs()
  },

  async cancelJob(id) {
    await window.shrinkly.cancelJob(id)
  },

  async cancelAll() {
    await window.shrinkly.cancelAll()
  },

  async removeJob(id) {
    await window.shrinkly.removeJob(id)
    await get().refreshJobs()
  },

  async moveJob(id, delta) {
    await window.shrinkly.moveJob(id, delta)
    await get().refreshJobs()
  },

  async clearFinished() {
    await window.shrinkly.clearFinished()
    await get().refreshJobs()
  },

  async updateSettings(patch) {
    const settings = await window.shrinkly.updateSettings(patch)
    const status = await window.shrinkly.getStatus()
    set({ status: { ...(status ?? { settings, ffmpeg: get().status?.ffmpeg, capabilities: get().status?.capabilities }), settings } })
  },

  async setFfmpegPath(ffmpegPath) {
    try {
      const status = await window.shrinkly.setFfmpegPath(ffmpegPath)
      set({ status })
      set({ toast: { kind: status.ffmpeg.state === 'ok' ? 'success' : 'error', message: status.ffmpeg.message } })
    } catch (error) {
      set({ toast: { kind: 'error', message: error instanceof Error ? error.message : String(error) } })
    }
  },

  async installFfmpeg() {
    try {
      const status = await window.shrinkly.installFfmpeg()
      set({ status })
      set({
        toast: {
          kind: status.ffmpeg.state === 'ok' ? 'success' : 'error',
          message: status.ffmpeg.state === 'ok' ? 'ffmpeg 安装成功' : status.ffmpeg.message
        }
      })
    } catch (error) {
      set({ toast: { kind: 'error', message: error instanceof Error ? error.message : String(error) } })
    }
  }
}))

export { selectedJob }
