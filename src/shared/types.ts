/**
 * Shrinkly 共享类型定义。
 *
 * 本文件被主进程、预加载脚本与渲染层同时引用，**不得依赖 Electron 或 Node API**。
 * 所有跨 IPC 边界的数据结构都在这里集中声明，避免 `any` 逃逸。
 */

/** 支持的输出容器。 */
export type ContainerFormat = 'mp4' | 'mkv' | 'webm' | 'mov'

/** 视频编码族（与具体编码器实现解耦）。 */
export type VideoCodec = 'h264' | 'hevc' | 'av1' | 'vp9'

/** 音频编码。 */
export type AudioCodec = 'aac' | 'opus' | 'mp3' | 'flac'

/** 音频处理模式：重编码 / 直接复制 / 移除。 */
export type AudioMode = 'encode' | 'copy' | 'none'

/** 码率控制方式。 */
export type RateControl = 'crf' | 'abr' | 'pass2'

/** 输出同名文件冲突策略。 */
export type ConflictStrategy = 'ask' | 'rename' | 'overwrite' | 'skip'

/** 任务状态机。 */
export type JobStatus = 'queued' | 'preparing' | 'running' | 'done' | 'failed' | 'canceled' | 'skipped'

/** 硬件加速后端。 */
export type HwAccelKind = 'none' | 'nvenc' | 'qsv' | 'amf'

// ---------------------------------------------------------------------------
// 媒体信息（ffprobe 解析结果）
// ---------------------------------------------------------------------------

export interface MediaVideoStream {
  /** 流索引（`-map 0:v:N` 使用视频流相对序号 N）。 */
  index: number
  codec: string
  codecLongName: string | null
  width: number
  height: number
  /** 帧率（avg_frame_rate 优先），无法解析时为 0。 */
  frameRate: number
  /** 视频码率 bit/s，未知为 null。 */
  bitRate: number | null
  pixelFormat: string | null
  colorSpace: string | null
  colorTransfer: string | null
  colorPrimaries: string | null
  /** 是否疑似 HDR 源（HLG / PQ 传递特性）。 */
  hdr: boolean
  interlaced: boolean
  sar: string | null
  dar: string | null
  durationSec: number | null
}

export interface MediaAudioStream {
  index: number
  codec: string | null
  /** 音频码率 bit/s，未知为 null。 */
  bitRate: number | null
  channels: number | null
  sampleRate: number | null
  language: string | null
}

export interface MediaInfo {
  path: string
  fileName: string
  /** 容器短名，例如 mp4 / matroska,webm。 */
  container: string | null
  formatLongName: string | null
  durationSec: number | null
  sizeBytes: number
  overallBitRate: number | null
  video: MediaVideoStream | null
  audio: MediaAudioStream | null
  videoStreamCount: number
  audioStreamCount: number
  subtitleStreamCount: number
  chapterCount: number
  /** 面向用户的中文提示（HDR、隔行、时长未知等）。 */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// 任务参数
// ---------------------------------------------------------------------------

export interface VideoOptions {
  codec: VideoCodec
  /** 具体编码器名（libx264 / h264_nvenc …），null 表示按 codec + hwAccel 自动选择。 */
  encoder: string | null
  rateControl: RateControl
  /** CRF / CQ 值，ABR 模式下为 null。 */
  crf: number | null
  /** 平均视频码率 kbps，CRF 模式下为 null。 */
  bitrateKbps: number | null
  /** 目标宽高，null 表示保持源分辨率。 */
  width: number | null
  height: number | null
  /** 目标帧率，null 表示保持源帧率。 */
  frameRate: number | null
  preset: string | null
  profile: string | null
  level: string | null
  pixelFormat: string | null
  gop: number | null
  bframes: number | null
  hwAccel: boolean
}

export interface AudioOptions {
  mode: AudioMode
  codec: AudioCodec
  /** 目标码率 kbps；copy 模式忽略。 */
  bitrateKbps: number | null
  /** 0 = 保持源声道数；1 / 2 = 强制单声道 / 立体声。 */
  channels: 0 | 1 | 2
  /** 目标采样率 Hz，null 保持源。 */
  sampleRate: number | null
}

export interface OutputOptions {
  /** 输出目录，null 表示与源文件同目录。 */
  directory: string | null
  /** 命名模板，支持 {name} {ext} {codec} {resolution} {fps} {q} {date} {time} {index}。 */
  nameTemplate: string
  conflict: ConflictStrategy
  keepMetadata: boolean
  keepChapters: boolean
}

export interface JobSpec {
  inputPath: string
  container: ContainerFormat
  video: VideoOptions
  audio: AudioOptions
  output: OutputOptions
  /** 白名单校验后的额外 ffmpeg 参数。 */
  extraArgs: string[]
}

/** 主进程解析出的实际读写路径。 */
export interface JobPaths {
  input: string
  output: string
  /** 临时文件路径（`<name>.part.<ext>`）。 */
  temporary: string
}

// ---------------------------------------------------------------------------
// 进度与结果
// ---------------------------------------------------------------------------

export interface ProgressInfo {
  /** 0–100，未知时长时为 0。 */
  percent: number
  /** 已处理时长（秒）。 */
  timeSec: number
  frame: number | null
  fps: number | null
  /** 编码速度倍率（例如 2.4 表示 2.4x）。 */
  speed: number | null
  /** 预计剩余秒数，未知为 null。 */
  etaSec: number | null
  /** 已写出字节数。 */
  bytes: number | null
}

export interface JobError {
  code: string
  title: string
  detail: string
  hint: string
  /** 原始 stderr 尾部，仅用于展开查看。 */
  raw?: string
}

export interface JobResult {
  outputPath: string
  sizeBytes: number
  sourceSizeBytes: number
  /** 输出/源 体积比，0.42 表示压缩到 42%。 */
  ratio: number
  elapsedMs: number
  encoder: string
  container: ContainerFormat
  width: number | null
  height: number | null
  frameRate: number | null
  videoBitrateKbps: number | null
  audioBitrateKbps: number | null
  audioCodec: string | null
  /** 是否发生过硬件编码回退。 */
  hwFallback: boolean
  logPath: string | null
}

export interface JobRecord {
  id: string
  inputPath: string
  fileName: string
  status: JobStatus
  progress: ProgressInfo
  spec: JobSpec
  media: MediaInfo | null
  /** 入队时的估算结果（用于硬件编码码率上限与结果对比）。 */
  estimate: EstimateResult | null
  result: JobResult | null
  error: JobError | null
  /** 队列中的显示顺序。 */
  order: number
  addedAt: number
  startedAt: number | null
  finishedAt: number | null
}

// ---------------------------------------------------------------------------
// 估算
// ---------------------------------------------------------------------------

export interface EstimateInput {
  media: MediaInfo
  /** 0–100 质量滑块。 */
  quality: number
  videoCodec: VideoCodec
  container: ContainerFormat
  audioCodec: AudioCodec
  audioMode: AudioMode
  /** 目标体积（MB）；非 null 时进入目标体积反解模式。 */
  targetSizeMB: number | null
  hwAccel: boolean
}

export interface EstimateResult {
  ok: boolean
  error: JobError | null
  container: ContainerFormat
  videoCodec: VideoCodec
  encoder: string
  width: number
  height: number
  /** 源分辨率，便于界面显示「1080p → 720p」。 */
  sourceWidth: number
  sourceHeight: number
  /** 分辨率是否被下调（false 表示保持源）。 */
  scaledResolution: boolean
  frameRate: number
  /** 源帧率。 */
  sourceFrameRate: number
  /** 帧率是否被下调。 */
  changedFrameRate: boolean
  /** 源时长（秒），未知为 null。 */
  durationSec: number | null
  videoBitrateKbps: number
  audioBitrateKbps: number
  totalBitrateKbps: number
  estimatedBytes: number
  /** 相对源文件体积的比例，1 表示不变。 */
  ratio: number
  crf: number | null
  rateControl: RateControl
  quality: number
  targetSizeMB: number | null
  /** 目标体积不可达时给出的最小可达体积（MB）。 */
  minimumSizeMB: number | null
  audioChannels: number
  audioSampleRate: number | null
  /** 面向用户的中文推导说明。 */
  explanations: string[]
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  field: string
  code: string
  message: string
  hint: string
}

export interface ValidationResult {
  ok: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

// ---------------------------------------------------------------------------
// FFmpeg 探测与能力
// ---------------------------------------------------------------------------

export type FfmpegState = 'ok' | 'missing' | 'invalid'

export interface FfmpegStatus {
  state: FfmpegState
  ffmpegPath: string | null
  ffprobePath: string | null
  version: string | null
  /** 二进制来源：自定义路径 / 系统 PATH / 未找到。 */
  source: 'custom' | 'path' | 'none'
  message: string
}

export interface EncoderCapability {
  id: string
  codec: VideoCodec
  kind: 'software' | 'nvenc' | 'qsv' | 'amf'
  available: boolean
}

export interface Capabilities {
  version: string | null
  /** 所有可用编码器 id。 */
  encoders: string[]
  /** 按 codec 归组的可用性。 */
  videoEncoders: EncoderCapability[]
  /** 可用的硬件加速后端。 */
  hwaccels: HwAccelKind[]
  /** 音频编码器可用性。 */
  audioEncoders: string[]
  probedAt: number
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

export interface AppSettings {
  /** 自定义 ffmpeg 可执行文件路径，null 表示使用 PATH。 */
  ffmpegPath: string | null
  defaultQuality: number
  defaultConflict: ConflictStrategy
  outputDirectory: string | null
  nameTemplate: string
  /** 并发任务上限，默认 1。 */
  concurrency: number
  hwAccel: boolean
}

export interface InstallProgress {
  phase: 'running' | 'done' | 'failed'
  line: string
  exitCode: number | null
}
