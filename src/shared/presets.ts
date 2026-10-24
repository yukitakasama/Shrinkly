/**
 * 容器 / 编码器矩阵、质量档位与编码器能力表。
 *
 * 全部为纯数据与纯函数，可在 Node 与浏览器环境复用，被 `estimate` / `validation` /
 * `args` 共同引用，保证界面估算与最终执行参数一致。
 */
import type { AudioCodec, ContainerFormat, HwAccelKind, VideoCodec } from './types'

/** FFmpeg 中容器对应的 muxer 名称。 */
export const CONTAINER_MUXER: Record<ContainerFormat, string> = {
  mp4: 'mp4',
  mkv: 'matroska',
  webm: 'webm',
  mov: 'mov'
}

export const CONTAINER_INFO: Record<
  ContainerFormat,
  {
    label: string
    extension: string
    video: VideoCodec[]
    audio: AudioCodec[]
    /** 是否支持 faststart（moov 前置）。 */
    faststart: boolean
    note: string
  }
> = {
  mp4: {
    label: 'MP4',
    extension: 'mp4',
    video: ['h264', 'hevc', 'av1'],
    audio: ['aac', 'mp3', 'flac'],
    faststart: true,
    note: '兼容性最好，适合分享与网盘；不支持 Opus / Vorbis'
  },
  mkv: {
    label: 'MKV',
    extension: 'mkv',
    video: ['h264', 'hevc', 'av1', 'vp9'],
    audio: ['aac', 'opus', 'mp3', 'flac'],
    faststart: false,
    note: '全部编码组合均可用，可保留字幕与章节'
  },
  webm: {
    label: 'WebM',
    extension: 'webm',
    video: ['vp9', 'av1'],
    audio: ['opus'],
    faststart: false,
    note: '仅支持 VP9 / AV1 + Opus，网页播放友好'
  },
  mov: {
    label: 'MOV',
    extension: 'mov',
    // 实测（ffmpeg 2026-07-02 gyan essentials）：mov muxer 不接受 FLAC 音轨与 AV1 视频，
    // 因此这里只声明实际可用的组合，避免用户配置出必定失败的参数。
    video: ['h264', 'hevc'],
    audio: ['aac', 'mp3'],
    faststart: true,
    note: '苹果生态常用；仅支持 H.264 / HEVC + AAC / MP3'
  }
}

export const CONTAINER_FORMATS: ContainerFormat[] = ['mp4', 'mkv', 'webm', 'mov']

export const VIDEO_CODEC_LABELS: Record<VideoCodec, string> = {
  h264: 'H.264',
  hevc: 'HEVC (H.265)',
  av1: 'AV1',
  vp9: 'VP9'
}

export const AUDIO_CODEC_LABELS: Record<AudioCodec, string> = {
  aac: 'AAC',
  opus: 'Opus',
  mp3: 'MP3',
  flac: 'FLAC'
}

export interface CodecProfile {
  codec: VideoCodec
  /** 软件编码器 id。 */
  softwareEncoder: string
  /** 硬件编码器 id（按优先级）。 */
  hwEncoders: Partial<Record<Exclude<HwAccelKind, 'none'>, string>>
  /** CRF 合法区间。 */
  crfRange: { min: number; max: number }
  /** 质量 → CRF 系数：round(a - b*q)。 */
  crfFormula: { a: number; b: number }
  /** 相对 x264 的码率效率（越小越省码率）。 */
  efficiency: number
  /** 给定分辨率与帧率下的最低可接受 bpp。 */
  minBpp: number
  /** 绝对最低码率（kbps）。 */
  minBitrateKbps: number
  /** 硬件编码相对软件 CRF 的补偿量。 */
  hwCrfOffset: number
  /** 编码器额外参数（例如 VP9 的 row-mt）。 */
  extraArgs: string[]
  /** 建议的 cpu-used（AV1 / VP9 软件编码）。 */
  cpuUsed: number | null
}

export const CODEC_PROFILES: Record<VideoCodec, CodecProfile> = {
  h264: {
    codec: 'h264',
    softwareEncoder: 'libx264',
    hwEncoders: { nvenc: 'h264_nvenc', qsv: 'h264_qsv', amf: 'h264_amf' },
    crfRange: { min: 0, max: 51 },
    crfFormula: { a: 36, b: 0.2 },
    efficiency: 1.0,
    minBpp: 0.05,
    minBitrateKbps: 80,
    hwCrfOffset: 2,
    extraArgs: [],
    cpuUsed: null
  },
  hevc: {
    codec: 'hevc',
    softwareEncoder: 'libx265',
    hwEncoders: { nvenc: 'hevc_nvenc', qsv: 'hevc_qsv', amf: 'hevc_amf' },
    crfRange: { min: 0, max: 51 },
    crfFormula: { a: 34, b: 0.19 },
    efficiency: 0.65,
    minBpp: 0.035,
    minBitrateKbps: 60,
    hwCrfOffset: 2,
    extraArgs: [],
    cpuUsed: null
  },
  av1: {
    codec: 'av1',
    softwareEncoder: 'libaom-av1',
    hwEncoders: { nvenc: 'av1_nvenc', qsv: 'av1_qsv', amf: 'av1_amf' },
    crfRange: { min: 0, max: 63 },
    crfFormula: { a: 42, b: 0.26 },
    efficiency: 0.55,
    minBpp: 0.028,
    minBitrateKbps: 50,
    hwCrfOffset: 2,
    extraArgs: ['-row-mt', '1'],
    cpuUsed: 6
  },
  vp9: {
    codec: 'vp9',
    softwareEncoder: 'libvpx-vp9',
    hwEncoders: { nvenc: 'vp9_nvenc', qsv: 'vp9_qsv', amf: 'vp9_amf' },
    crfRange: { min: 0, max: 63 },
    crfFormula: { a: 40, b: 0.24 },
    efficiency: 0.75,
    minBpp: 0.04,
    minBitrateKbps: 60,
    hwCrfOffset: 2,
    extraArgs: ['-row-mt', '1'],
    cpuUsed: 2
  }
}

export const VIDEO_CODECS: VideoCodec[] = ['h264', 'hevc', 'av1', 'vp9']

/** 音频编码器映射：逻辑编码 → ffmpeg 编码器。 */
export const AUDIO_ENCODER: Record<AudioCodec, string> = {
  aac: 'aac',
  opus: 'libopus',
  mp3: 'libmp3lame',
  flac: 'flac'
}

/** 音频编码 → 容器内的 codec_name，用于 copy 兼容性判定。 */
export const AUDIO_STREAM_CODEC: Record<AudioCodec, string> = {
  aac: 'aac',
  opus: 'opus',
  mp3: 'mp3',
  flac: 'flac'
}

/** 各编码器的默认码率（kbps），用于「目标体积」模式之外的回退。 */
export const AUDIO_BITRATE_TABLE: Record<'aac' | 'opus', Array<{ maxQuality: number; kbps: number }>> = {
  aac: [
    { maxQuality: 19, kbps: 64 },
    { maxQuality: 39, kbps: 96 },
    { maxQuality: 59, kbps: 128 },
    { maxQuality: 79, kbps: 160 },
    { maxQuality: 100, kbps: 192 }
  ],
  opus: [
    { maxQuality: 19, kbps: 48 },
    { maxQuality: 39, kbps: 64 },
    { maxQuality: 59, kbps: 96 },
    { maxQuality: 79, kbps: 128 },
    { maxQuality: 100, kbps: 160 }
  ]
}

/** 质量滑块刻度标签。 */
export const QUALITY_STOPS: Array<{ value: number; label: string }> = [
  { value: 0, label: '极致压缩' },
  { value: 20, label: '高压缩' },
  { value: 40, label: '标准压缩' },
  { value: 60, label: '均衡' },
  { value: 80, label: '高清' },
  { value: 100, label: '近原画质' }
]

/** 默认质量档位。 */
export const DEFAULT_QUALITY = 60

/** 分辨率候选高度（长边优先，竖屏按短边换算）。 */
export const RESOLUTION_HEIGHTS: number[] = [2160, 1440, 1080, 720, 480, 360]

/** 分辨率下限（短边像素）。 */
export const MIN_RESOLUTION_SHORT_SIDE = 360

/** 软件编码预设档位。 */
export const X264_PRESETS: string[] = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow'
]

/** 硬件编码预设（NVENC p1–p7）映射。 */
export const HW_PRESET_MAP: Record<string, string> = {
  ultrafast: 'p1',
  superfast: 'p2',
  veryfast: 'p3',
  faster: 'p4',
  fast: 'p4',
  medium: 'p5',
  slow: 'p6',
  slower: 'p7',
  veryslow: 'p7'
}

/** 默认软件预设。 */
export const DEFAULT_PRESET = 'medium'

/** 码率估算：每像素每帧比特数。 */
export function bppForQuality(quality: number): number {
  const q = clampQuality(quality) / 100
  return 0.02 + 0.16 * Math.pow(q, 1.6)
}

/** 质量 → CRF（软件编码器）。 */
export function crfForQuality(codec: VideoCodec, quality: number): number {
  const profile = CODEC_PROFILES[codec]
  const value = Math.round(profile.crfFormula.a - profile.crfFormula.b * clampQuality(quality))
  return Math.min(profile.crfRange.max, Math.max(profile.crfRange.min, value))
}

/** 质量 → 硬件编码器 CQ 值（比软件 CRF 略高）。 */
export function cqForQuality(codec: VideoCodec, quality: number): number {
  const profile = CODEC_PROFILES[codec]
  const value = crfForQuality('h264', quality) + profile.hwCrfOffset
  return Math.min(profile.crfRange.max, Math.max(profile.crfRange.min, value))
}

/** 质量 → 音频码率（kbps）。 */
export function audioBitrateForQuality(codec: AudioCodec, quality: number): number {
  const q = clampQuality(quality)
  if (codec === 'flac') return 0
  const table = AUDIO_BITRATE_TABLE[codec === 'opus' ? 'opus' : 'aac']
  const hit = table.find((entry) => q <= entry.maxQuality)
  return hit ? hit.kbps : table[table.length - 1].kbps
}

/** 距离给定质量最近刻度的文案。 */
export function qualityLabel(quality: number): string {
  const q = clampQuality(quality)
  let best = QUALITY_STOPS[0]
  let bestDistance = Math.abs(best.value - q)
  for (const stop of QUALITY_STOPS) {
    const distance = Math.abs(stop.value - q)
    if (distance < bestDistance) {
      best = stop
      bestDistance = distance
    }
  }
  return best.label
}

export function clampQuality(quality: number): number {
  if (!Number.isFinite(quality)) return DEFAULT_QUALITY
  return Math.min(100, Math.max(0, quality))
}

/** 容器是否支持该视频编码。 */
export function isVideoCodecSupported(container: ContainerFormat, codec: VideoCodec): boolean {
  return CONTAINER_INFO[container].video.includes(codec)
}

/** 容器是否支持该音频编码。 */
export function isAudioCodecSupported(container: ContainerFormat, codec: AudioCodec): boolean {
  return CONTAINER_INFO[container].audio.includes(codec)
}

export interface CodecRemapResult {
  videoCodec: VideoCodec
  audioCodec: AudioCodec
  /** 因切换容器而被迫改变的编码说明（用于界面提示）。 */
  changes: string[]
}

/**
 * 切换输出容器时，把不兼容的视频 / 音频编码映射到该容器支持的第一项。
 *
 * 只做「保底可用」的映射：优先保留同族编码（例如 HEVC 在 MOV 里仍然可用），
 * 因此不会把用户的选择随意改成别的编码族。
 */
export function remapCodecsForContainer(
  container: ContainerFormat,
  videoCodec: VideoCodec,
  audioCodec: AudioCodec,
  audioMode: 'encode' | 'copy' | 'none'
): CodecRemapResult {
  const info = CONTAINER_INFO[container]
  const changes: string[] = []
  let nextVideo = videoCodec
  let nextAudio = audioCodec

  if (!info.video.includes(videoCodec)) {
    nextVideo = info.video[0]
    changes.push(`视频编码 ${VIDEO_CODEC_LABELS[videoCodec]} 不受 ${info.label} 支持，已改为 ${VIDEO_CODEC_LABELS[nextVideo]}`)
  }
  if (audioMode === 'encode' && !info.audio.includes(audioCodec)) {
    nextAudio = info.audio[0]
    changes.push(`音频编码 ${AUDIO_CODEC_LABELS[audioCodec]} 不受 ${info.label} 支持，已改为 ${AUDIO_CODEC_LABELS[nextAudio]}`)
  }

  return { videoCodec: nextVideo, audioCodec: nextAudio, changes }
}

/** 依据编码族与硬件加速开关选择编码器 id。 */
export function preferredEncoder(codec: VideoCodec, hwAccel: boolean, backend: Exclude<HwAccelKind, 'none'> = 'nvenc'): string {
  const profile = CODEC_PROFILES[codec]
  if (hwAccel) {
    const hw = profile.hwEncoders[backend]
    if (hw) return hw
  }
  return profile.softwareEncoder
}

/** 编码器 id → 编码族。 */
export function codecForEncoder(encoder: string): VideoCodec | null {
  for (const codec of VIDEO_CODECS) {
    const profile = CODEC_PROFILES[codec]
    if (profile.softwareEncoder === encoder) return codec
    if (Object.values(profile.hwEncoders).includes(encoder)) return codec
  }
  return null
}

/** 编码器是否为硬件编码器。 */
export function isHardwareEncoder(encoder: string): boolean {
  return /_nvenc$|_qsv$|_amf$|_vaapi$|_videotoolbox$/.test(encoder)
}

/** 硬件后端识别。 */
export function hwBackendOf(encoder: string): HwAccelKind {
  if (encoder.endsWith('_nvenc')) return 'nvenc'
  if (encoder.endsWith('_qsv')) return 'qsv'
  if (encoder.endsWith('_amf')) return 'amf'
  return 'none'
}
