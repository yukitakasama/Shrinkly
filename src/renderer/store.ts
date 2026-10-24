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
  HwMode,
  JobRecord,
  ValidationIssue,
  ValidationResult,
  VideoCodec
} from '../shared/types'
import { api, subscribeEvents } from './lib/api'
import { sanitizeExtraArgs } from '../shared/validation'
import { remapCodecsForContainer } from '../shared/presets'
import { resolveAcceleration, type AccelerationDecision } from '../shared/hardware'
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
  /** 简易模式的硬件加速选择；最终是否真的走 GPU 由 `acceleration` 决定。 */
  hwMode: HwMode
  /** 当前参数下实际使用的计算方式（估算完成后更新）。 */
  acceleration: AccelerationDecision | null
  /** 切换输出格式时的自动改写提示（例如 VP9 → H.264）。 */
  containerHint: string | null
  advanced: AdvancedValues | null
  estimate: EstimateResult | null
  validation: ValidationResult | null
  command: string
  editing: boolean
  importing: boolean
  /** 「开始压缩」请求进行中，防止重复点击。 */
  starting: boolean
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
  setHwMode: (mode: HwMode) => void
  rescanHardware: () => Promise<void>
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
  hwMode: 'auto',
  acceleration: null,
  containerHint: null,
  advanced: null,
  estimate: null,
  validation: null,
  command: '',
  editing: false,
  importing: false,
  starting: false,
  toast: null,
  logs: [],
  picker: null,

  async init() {
    try {
      const status = await api.status()
      set({
        status,
        quality: status.settings.defaultQuality,
        hwMode: status.settings.defaultHwMode ?? 'auto'
      })
      await get().refreshJobs()
      set({ logs: (await api.logs(500)).slice(-500) })
      if (status.hardware.state !== 'ready') {
        void api
          .probeHardware()
          .then((hardware) => {
            const current = get().status
            if (current) set({ status: { ...current, hardware } })
            return get().refreshEditor()
          })
          .catch(() => undefined)
      }
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
    set({ jobs, selectedId: currentId, advanced: null, containerHint: null, ...editorFieldsFor(job) })
    if (currentId) await get().refreshEditor()
  },

  setMode(mode) {
    set({ mode })
  },

  selectJob(id) {
    const job = get().jobs.find((item) => item.id === id) ?? null
    set({ selectedId: id, advanced: null, containerHint: null, ...editorFieldsFor(job) })
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
    const state = get()
    if (state.container === container) return
    const remapped = remapCodecsForContainer(container, state.videoCodec, state.audioCodec, state.audioMode)
    set({
      container,
      videoCodec: remapped.videoCodec,
      audioCodec: remapped.audioCodec,
      containerHint: remapped.changes.length > 0 ? `${remapped.changes.join('；')}（已按 ${container.toUpperCase()} 容器自动调整）` : null
    })
    get().scheduleRefresh()
  },

  setHwMode(mode) {
    set({ hwMode: mode })
    get().scheduleRefresh()
  },

  async rescanHardware() {
    try {
      const hardware = await api.probeHardware()
      const status = get().status
      if (status) set({ status: { ...status, hardware } })
      set({ toast: { kind: hardware.usable.length > 0 ? 'success' : 'info', message: hardware.message } })
      await get().refreshEditor()
    } catch (error) {
      set({ toast: { kind: 'error', message: errorMessage(error) } })
    }
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
          const acceleration = resolveAcceleration(
            get().hwMode,
            get().status?.hardware ?? null,
            targets.videoCodec
          )
          const estimate = await api.estimate({
            media,
            quality: settings?.defaultQuality ?? 60,
            videoCodec: targets.videoCodec,
            container: targets.container,
            audioCodec: targets.audioCodec,
            audioMode: targets.audioMode,
            targetSizeMB: null,
            hwAccel: acceleration.hwAccel,
            hwEncoder: acceleration.encoder
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
            hwAccel: acceleration.hwAccel
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
      set({ estimate: null, validation: null, command: '', acceleration: null })
      return
    }
    const media = job.media
    const settings = state.status?.settings
    const advanced = state.advanced
    const audioMode = state.audioMode
    const audioCodec = state.audioCodec
    const hardware = state.status?.hardware ?? null
    // 高级模式的开关等价于「强制 GPU / 强制 CPU」；简易模式则按三态选择解析。
    const requested: HwMode = advanced ? (advanced.hwAccel ? 'gpu' : 'cpu') : state.hwMode
    const acceleration = resolveAcceleration(requested, hardware, state.videoCodec)

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
        hwAccel: acceleration.hwAccel,
        hwEncoder: acceleration.encoder
      })

      if (!estimate.ok) {
        set({ estimate, validation: null, command: '', acceleration })
        return
      }

      const sanitizedExtra = advanced?.extraArgsText
        ? sanitizeExtraArgs(advanced.extraArgsText)
        : { args: [] as string[], issues: [] as ValidationIssue[] }
      const extra = sanitizedExtra.args
      const spec = buildJobSpec({
        media,
        estimate,
        audioMode,
        audioCodec,
        outputDirectory: advanced?.outputDirectory ?? settings?.outputDirectory ?? null,
        nameTemplate: advanced?.nameTemplate ?? settings?.nameTemplate ?? '{name}_compressed.{ext}',
        conflict: advanced?.conflict ?? settings?.defaultConflict ?? 'rename',
        hwAccel: acceleration.hwAccel,
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
              hwAccel: acceleration.hwAccel
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
          sourceHeight: media.video?.height ?? null,
          availableEncoders: state.status?.capabilities?.encoders ?? null
        }
      })

      // 额外参数中不合法的部分会被过滤掉后再交给服务端，所以这里要把它们自己的
      // 报错补回校验结果，否则界面上完全看不到提示。
      const extraErrors = sanitizedExtra.issues.filter(
        (issue) => issue.code === 'FORBIDDEN_ARG' || issue.code === 'OUTPUT_PATH_ARG'
      )
      const extraWarnings = sanitizedExtra.issues.filter((issue) => !extraErrors.includes(issue))
      const mergedValidation: ValidationResult =
        sanitizedExtra.issues.length > 0
          ? {
              ok: validation.ok && extraErrors.length === 0,
              errors: [...validation.errors, ...extraErrors],
              warnings: [...validation.warnings, ...extraWarnings]
            }
          : validation

      // 参数不合法时服务端会拒绝生成命令（400），所以先落校验结果，再做命令预览，
      // 否则预览失败会把刚算出来的错误一起吞掉。
      set({ estimate, validation: mergedValidation, acceleration })
      if (!mergedValidation.ok) {
        set({ command: '' })
        return
      }

      const preview = await api.previewArgs({
        spec,
        outputPath: `${media.path.replace(/\.[^.]+$/, '')}_compressed.${estimate.container}`
      })

      set({ command: preview.command })

      if (job.status === 'queued' || job.status === 'preparing') {
        await api.updateJob(job.id, { spec, estimate })
      }
    } catch (error) {
      set({ toast: { kind: 'error', message: errorMessage(error) } })
    } finally {
      set({ editing: false })
    }
  },

  async startQueue() {
    if (get().starting) return
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    const pending = get().jobs.filter((item) => item.status === 'queued').length
    if (pending === 0) {
      set({ toast: { kind: 'info', message: '没有待转换的任务，请先导入文件' } })
      return
    }
    const job = selectedJob(get())
    if (job && (job.status === 'queued' || job.status === 'preparing')) {
      await get().refreshEditor()
    }
    if (get().jobs.filter((item) => item.status === 'queued').length === 0) {
      set({ toast: { kind: 'error', message: '当前参数无法开始转换，请先修正提示中的问题' } })
      return
    }
    set({ starting: true })
    try {
      await api.startQueue()
      await get().refreshJobs()
    } catch (error) {
      set({ toast: { kind: 'error', message: errorMessage(error) } })
    } finally {
      set({ starting: false })
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
      const status = await api.status()
      set({ status, ...(patch.defaultHwMode ? { hwMode: patch.defaultHwMode } : {}) })
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
