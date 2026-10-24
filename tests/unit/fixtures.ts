import type { EstimateInput, JobSpec, MediaInfo } from '../../src/shared/types'

export interface MediaOptions {
  width?: number
  height?: number
  frameRate?: number
  videoBitRate?: number | null
  videoCodecName?: string
  hasVideo?: boolean
  hasAudio?: boolean
  audioBitRate?: number | null
  audioChannels?: number | null
  audioSampleRate?: number | null
  audioCodecName?: string | null
  durationSec?: number | null
  sizeBytes?: number
  hdr?: boolean
}

/** 构造一个默认 1920×1080@30 H.264 + AAC 128k 的 MediaInfo。 */
export function makeMedia(options: MediaOptions = {}): MediaInfo {
  const width = options.width ?? 1920
  const height = options.height ?? 1080
  const frameRate = options.frameRate ?? 30
  const hasVideo = options.hasVideo ?? true
  const hasAudio = options.hasAudio ?? true
  const durationSec = options.durationSec === undefined ? 100 : options.durationSec

  return {
    path: 'D:/videos/样片 sample.mp4',
    fileName: '样片 sample.mp4',
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    formatLongName: 'QuickTime / MOV',
    durationSec,
    sizeBytes: options.sizeBytes ?? 300 * 1024 * 1024,
    overallBitRate: 25_000_000,
    video: hasVideo
      ? {
          index: 0,
          codec: options.videoCodecName ?? 'h264',
          codecLongName: 'H.264 / AVC',
          width,
          height,
          frameRate,
          bitRate: options.videoBitRate === undefined ? null : options.videoBitRate,
          pixelFormat: 'yuv420p',
          colorSpace: 'bt709',
          colorTransfer: 'bt709',
          colorPrimaries: 'bt709',
          hdr: options.hdr ?? false,
          interlaced: false,
          sar: '1:1',
          dar: '16:9',
          durationSec
        }
      : null,
    audio: hasAudio
      ? {
          index: 1,
          codec: options.audioCodecName === undefined ? 'aac' : options.audioCodecName,
          bitRate: options.audioBitRate === undefined ? 128_000 : options.audioBitRate,
          channels: options.audioChannels === undefined ? 2 : options.audioChannels,
          sampleRate: options.audioSampleRate === undefined ? 48_000 : options.audioSampleRate,
          language: 'und'
        }
      : null,
    videoStreamCount: hasVideo ? 1 : 0,
    audioStreamCount: hasAudio ? 1 : 0,
    subtitleStreamCount: 0,
    chapterCount: 0,
    warnings: []
  }
}

/** 构造估算输入，默认 1080p30 源、质量 60、输出 MP4/H.264/AAC。 */
export function makeEstimateInput(overrides: Partial<EstimateInput> = {}): EstimateInput {
  return {
    media: makeMedia(),
    quality: 60,
    videoCodec: 'h264',
    container: 'mp4',
    audioCodec: 'aac',
    audioMode: 'encode',
    targetSizeMB: null,
    hwAccel: false,
    ...overrides
  }
}

/** 构造一份默认合法的 JobSpec（MP4 + H.264 + AAC）。 */
export function makeSpec(overrides: Partial<JobSpec> = {}): JobSpec {
  const base: JobSpec = {
    inputPath: 'D:/videos/样片 sample.mp4',
    container: 'mp4',
    video: {
      codec: 'h264',
      encoder: 'libx264',
      rateControl: 'crf',
      crf: 24,
      bitrateKbps: null,
      width: null,
      height: null,
      frameRate: null,
      preset: 'medium',
      profile: null,
      level: null,
      pixelFormat: 'yuv420p',
      gop: null,
      bframes: null,
      hwAccel: false
    },
    audio: {
      mode: 'encode',
      codec: 'aac',
      bitrateKbps: 160,
      channels: 0,
      sampleRate: null
    },
    output: {
      directory: null,
      nameTemplate: '{name}_compressed.{ext}',
      conflict: 'rename',
      keepMetadata: true,
      keepChapters: true
    },
    extraArgs: []
  }
  return {
    ...base,
    ...overrides,
    video: { ...base.video, ...(overrides.video ?? {}) },
    audio: { ...base.audio, ...(overrides.audio ?? {}) },
    output: { ...base.output, ...(overrides.output ?? {}) }
  }
}
