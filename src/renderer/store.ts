/**
 * 渲染层唯一状态源（Zustand）。
 *
 * 所有与本地服务端的交互都走 `lib/api`（HTTP + SSE），不再有 Electron IPC。
 */
import { create } from 'zustand'
import type { AppStatus, LogEntryPayload } from '../shared/api'
import type {
  AudioCodec,
  AudioMode,
  ContainerFormat,
  EstimateResult,
  JobRecord,
  ValidationResult,
  VideoCodec
} from '../shared/types'
import { api, subscribeEvents } from './lib/api'
import { sanitizeExtraArgs } from '../shared/validation'
import { buildJobSpec, deriveTargets } from './lib/spec'

export type Mode = 'simple' | 'advanced'

export type PickerMode = 'files' | 'directory' | 'executable'

export interface PickerRequest {
  mode: PickerMode
  resolve: (selection: string[] | null) => void
}

export interface Toast {
  kind: 'info' | 'error' | 'success'
  message: string
}

/** 高级模式的手动参数（null 表示按估算自动推导）。 */
export interface AdvancedValues {
  rateControl: 'crf' | 'abr' | 'pass2'
  crf: number | null
  bitrateKbps: number | null
  width: number | null
  height: number | null
  frameRate: number | null
  preset: string | null
  profile: string | null
  level: string | null
  pixelFormat: string | null
  gop: number | null
  bframes: number | null
  hwAccel: boolean
  audioBitrateKbps: number | null
  audioChannels: 0 | 1 | 2
  audioSampleRate: number | null
  outputDirectory: string | null
  nameTemplate: string
  conflict: 'ask' | 'rename' | 'overwrite' | 'skip'
  keepMetadata: boolean
  keepChapters: boolean
  extraArgsText: string
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
  advanced: AdvancedValues | null
  estimate: EstimateResult | null
  validation: ValidationResult | null
  command: string
  editing: boolean
  importing: boolean
  toast: Toast | null
  logs: LogEntryPayload[]
  picker: PickerRequest | null

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
  setAdvanced: (patch: Partial<AdvancedValues>) => void
  resetAdvanced: () => void
  importPaths: (paths: string[]) => Promise<void>
  refreshEditor: () => Promise<void>
  scheduleRefresh: () => void
  startQueue: () => Promise<void>
  cancelJob: (id: string) => Promise<void>
  cancelAll: () => Promise<void>
  removeJob: (id: string) => Promise<void>
  moveJob: (id: string, delta: number) => Promise<void>
  clearFinished: () => Promise<void>
  updateSettings: (patch: Partial<NonNullable<AppStatus['settings']>>) => Promise<void>
  setFfmpegPath: (ffmpegPath: string | null) => Promise<void>
  installFfmpeg: () => Promise<void>
  openPicker: (mode: PickerMode) => Promise<string[] | null>
  closePicker: (selection: string[] | null) => void
  shutdown: () => Promise<void>
}

const REFRESH_DEBOUNCE_MS = 80
let refreshTimer: ReturnType<typeof setTimeout> | null = null

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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
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
  advanced: null,
  estimate: null,
  validation: null,
  command: '',
  editing: false,
  importing: false,
  toast: null,
  logs: [],
  picker: null,

  async init() {
    try {
      const status = await api.status()
      set({ status, quality: status.settings.defaultQuality })
      await get().refreshJobs()
      set({ logs: (await api.logs(500)).slice(-500) })
    } catch (error) {
      set({ toast: { kind: 'error', message: errorMessage(error) } })
    }

    subscribeEvents({
      jobUpdate: (job) => {
        set((state) => {
          const exists = state.jobs.some((item) => item.id === job.id)
          const jobs = exists ? state.jobs.map((item) => (item.id === job.id ? job : item)) : [...state.jobs, job]
          jobs.sort((a, b) => a.order - b.order)
          return { jobs }
        })
        if (job.id === get().selectedId) void get().refreshEditor()
      },
      jobProgress: ({ id, progress }) => {
        set((state) => ({ jobs: state.jobs.map((job) => (job.id === id ? { ...job, progress } : job)) }))
      },
      jobLog: ({ id, line }) => {
        set((state) => ({
          logs: [...state.logs.slice(-1500), { time: Date.now(), level: 'info' as const, scope: id.slice(0, 8), message: line }]
        }))
      },
      log: (entry) => {
        set((state) => ({ logs: [...state.logs.slice(-1500), entry] }))
      },
      install: (progress) => {
        if (progress.phase !== 'running') set({ toast: { kind: progress.phase === 'done' ? 'success' : 'error', message: progress.line } })
      }
    })
  },

  async refreshJobs() {
    const jobs = await api.listJobs()
    const currentId =
      get().selectedId && jobs.some((job) => job.id === get().selectedId) ? get().selectedId : (jobs[0]?.id ?? null)
    const job = jobs.find((item) => item.id === currentId) ?? null
    set({ jobs, selectedId: currentId, advanced: null, ...editorFieldsFor(job) })
    if (currentId) await get().refreshEditor()
  },

  setMode(mode) {
    set({ mode })
  },

  selectJob(id) {
    const job = get().jobs.find((item) => item.id === id) ?? null
    set({ selectedId: id, advanced: null, ...editorFieldsFor(job) })
    void get().refreshEditor()
  },

  setToast(toast) {
    set({ toast })
  },

  setQuality(quality) {
    set({ quality })
    get().scheduleRefresh()
  },

  setTarget(enabled, mb) {
    set({ targetEnabled: enabled, ...(mb !== undefined ? { targetMB: mb } : {}) })
    get().scheduleRefresh()
  },

  setContainer(container) {
    set({ container })
    get().scheduleRefresh()
  },

  setVideoCodec(videoCodec) {
    set({ videoCodec })
    get().scheduleRefresh()
  },

  setAudioCodec(audioCodec) {
    set({ audioCodec })
    get().scheduleRefresh()
  },

  setAudioMode(audioMode) {
    set({ audioMode })
    get().scheduleRefresh()
  },

  setAdvanced(patch) {
    const current = get().advanced
    const estimate = get().estimate
    const settings = get().status?.settings
    const base: AdvancedValues =
      current ?? {
        rateControl: estimate?.rateControl ?? 'crf',
        crf: estimate?.crf ?? 24,
        bitrateKbps: estimate ? Math.round(estimate.videoBitrateKbps) : null,
        width: estimate?.width ?? null,
        height: estimate?.height ?? null,
        frameRate: estimate?.frameRate ?? null,
        preset: 'medium',
        profile: null,
        level: null,
        pixelFormat: 'yuv420p',
        gop: null,
        bframes: null,
        hwAccel: settings?.hwAccel ?? false,
        audioBitrateKbps: estimate?.audioBitrateKbps ?? null,
        audioChannels: 0,
        audioSampleRate: estimate?.audioSampleRate ?? null,
        outputDirectory: settings?.outputDirectory ?? null,
        nameTemplate: settings?.nameTemplate ?? '{name}_compressed.{ext}',
        conflict: settings?.defaultConflict ?? 'rename',
        keepMetadata: true,
        keepChapters: true,
        extraArgsText: ''
      }
    set({ advanced: { ...base, ...patch } })
    get().scheduleRefresh()
  },

  resetAdvanced() {
    set({ advanced: null })
    get().scheduleRefresh()
  },

  /** 防抖：滑块 / 输入框连续变化时只算最后一次。 */
  scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void get().refreshEditor()
    }, REFRESH_DEBOUNCE_MS)
  },

  async importPaths(paths) {
    if (paths.length === 0) return
    set({ importing: true })
    try {
      const { files } = await api.expandPaths({ paths, recursive: true })
      if (files.length === 0) {
        set({ toast: { kind: 'error', message: '没有找到可导入的视频文件' } })
        return
      }
      const settings = get().status?.settings
      let added = 0
      for (const filePath of files) {
        try {
          const media = await api.probe(filePath)
          const targets = deriveTargets(media)
          const estimate = await api.estimate({
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
          await api.addJob({ spec, media, estimate })
          added += 1
        } catch (error) {
          set({ toast: { kind: 'error', message: `${filePath}：${errorMessage(error)}` } })
        }
      }
      await get().refreshJobs()
      if (added > 0) {
        set({ toast: { kind: 'success', message: `已加入 ${added} 个任务，确认参数后点「开始转换」` } })
      }
    } catch (error) {
      set({ toast: { kind: 'error', message: errorMessage(error) } })
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
    const advanced = state.advanced
    const audioMode = state.audioMode
    const audioCodec = state.audioCodec

    set({ editing: true })
    try {
      const estimate = await api.estimate({
        media,
        quality: state.quality,
        videoCodec: state.videoCodec,
        container: state.container,
        audioCodec,
        audioMode,
        targetSizeMB: state.targetEnabled ? state.targetMB : null,
        hwAccel: advanced?.hwAccel ?? settings?.hwAccel ?? false
      })

      if (!estimate.ok) {
        set({ estimate, validation: null, command: '' })
        return
      }

      const extra = advanced?.extraArgsText ? sanitizeExtraArgs(advanced.extraArgsText).args : []
      const spec = buildJobSpec({
        media,
        estimate,
        audioMode,
        audioCodec,
        outputDirectory: advanced?.outputDirectory ?? settings?.outputDirectory ?? null,
        nameTemplate: advanced?.nameTemplate ?? settings?.nameTemplate ?? '{name}_compressed.{ext}',
        conflict: advanced?.conflict ?? settings?.defaultConflict ?? 'rename',
        hwAccel: advanced?.hwAccel ?? settings?.hwAccel ?? false,
        keepMetadata: advanced?.keepMetadata ?? true,
        keepChapters: advanced?.keepChapters ?? true,
        extraArgs: extra,
        videoOverride: advanced
          ? {
              rateControl: advanced.rateControl,
              crf: advanced.rateControl === 'crf' ? advanced.crf : null,
              bitrateKbps: advanced.rateControl === 'crf' ? null : advanced.bitrateKbps,
              width: advanced.width,
              height: advanced.height,
              frameRate: advanced.frameRate,
              preset: advanced.preset,
              profile: advanced.profile,
              level: advanced.level,
              pixelFormat: advanced.pixelFormat,
              gop: advanced.gop,
              bframes: advanced.bframes,
              hwAccel: advanced.hwAccel
            }
          : undefined,
        audioOverride: advanced
          ? {
              bitrateKbps: audioMode === 'encode' ? advanced.audioBitrateKbps : null,
              channels: advanced.audioChannels,
              sampleRate: audioMode === 'encode' ? advanced.audioSampleRate : null
            }
          : undefined
      })

      const validation = await api.validate({
        spec,
        context: {
          sourceAudioCodec: media.audio?.codec ?? null,
          sourceWidth: media.video?.width ?? null,
          sourceHeight: media.video?.height ?? null
        }
      })

      const preview = await api.previewArgs({
        spec,
        outputPath: `${media.path.replace(/\.[^.]+$/, '')}_compressed.${estimate.container}`
      })

      set({ estimate, validation, command: preview.command })

      if (validation.ok && (job.status === 'queued' || job.status === 'preparing')) {
        await api.updateJob(job.id, { spec, estimate })
      }
    } catch (error) {
      set({ toast: { kind: 'error', message: errorMessage(error) } })
    } finally {
      set({ editing: false })
    }
  },

  async startQueue() {
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    const job = selectedJob(get())
    if (job && (job.status === 'queued' || job.status === 'preparing')) {
      await get().refreshEditor()
    }
    try {
      await api.startQueue()
      await get().refreshJobs()
    } catch (error) {
      set({ toast: { kind: 'error', message: errorMessage(error) } })
    }
  },

  async cancelJob(id) {
    await api.cancelJob(id)
  },

  async cancelAll() {
    await api.cancelAll()
  },

  async removeJob(id) {
    await api.removeJob(id)
    await get().refreshJobs()
  },

  async moveJob(id, delta) {
    await api.moveJob(id, { delta })
    await get().refreshJobs()
  },

  async clearFinished() {
    await api.clearFinished()
    await get().refreshJobs()
  },

  async updateSettings(patch) {
    try {
      await api.updateSettings(patch)
      set({ status: await api.status() })
      await get().refreshEditor()
    } catch (error) {
      set({ toast: { kind: 'error', message: errorMessage(error) } })
    }
  },

  async setFfmpegPath(ffmpegPath) {
    try {
      const status = await api.setFfmpegPath(ffmpegPath)
      set({ status })
      set({ toast: { kind: status.ffmpeg.state === 'ok' ? 'success' : 'error', message: status.ffmpeg.message } })
    } catch (error) {
      set({ toast: { kind: 'error', message: errorMessage(error) } })
    }
  },

  async installFfmpeg() {
    try {
      const status = await api.installFfmpeg()
      set({ status })
      set({
        toast: {
          kind: status.ffmpeg.state === 'ok' ? 'success' : 'error',
          message: status.ffmpeg.state === 'ok' ? 'ffmpeg 安装成功' : status.ffmpeg.message
        }
      })
    } catch (error) {
      set({ toast: { kind: 'error', message: errorMessage(error) } })
    }
  },

  openPicker(mode) {
    return new Promise<string[] | null>((resolve) => {
      const previous = get().picker?.resolve
      if (previous) previous(null)
      set({ picker: { mode, resolve } })
    })
  },

  closePicker(selection) {
    const request = get().picker
    set({ picker: null })
    request?.resolve(selection)
  },

  async shutdown() {
    try {
      await api.shutdown()
      set({ toast: { kind: 'info', message: '服务已关闭，可以关闭此页面了' } })
    } catch (error) {
      set({ toast: { kind: 'error', message: errorMessage(error) } })
    }
  }
}))

export { selectedJob }
