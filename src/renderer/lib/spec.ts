/**
 * 渲染层：把「源信息 + 质量设置」组装成 JobSpec。
 *
 * 只负责把估算结果映射为参数，真正的合法性由 `shared/validation` 与主进程复核。
 */
import {
  CONTAINER_INFO,
  DEFAULT_PRESET,
  audioBitrateForQuality,
  isAudioCodecSupported,
  isVideoCodecSupported
} from '../../shared/presets'
import type {
  AudioCodec,
  AudioMode,
  ContainerFormat,
  EstimateResult,
  JobSpec,
  MediaInfo,
  VideoCodec
} from '../../shared/types'

/** 从源容器推断输出容器（不支持的容器退回 MP4）。 */
export function deriveContainer(media: MediaInfo): ContainerFormat {
  const name = (media.container ?? '').toLowerCase()
  if (name.includes('webm')) return 'webm'
  if (name.includes('matroska')) return 'mkv'
  if (name.includes('mp4') || name.includes('mov') || name.includes('m4a')) return 'mp4'
  return 'mp4'
}

/** 从源码编码推断目标编码族。 */
export function deriveVideoCodec(media: MediaInfo): VideoCodec {
  const codec = (media.video?.codec ?? '').toLowerCase()
  if (codec.includes('hevc') || codec.includes('h265')) return 'hevc'
  if (codec.includes('av1')) return 'av1'
  if (codec.includes('vp9')) return 'vp9'
  return 'h264'
}

/** 音频默认编码：WebM 用 Opus，其余用 AAC。 */
export function deriveAudioCodec(container: ContainerFormat): AudioCodec {
  return container === 'webm' ? 'opus' : 'aac'
}

export interface TargetDefaults {
  container: ContainerFormat
  videoCodec: VideoCodec
  audioCodec: AudioCodec
  audioMode: AudioMode
}

/** 依据源文件推导一组互相兼容的默认目标。 */
export function deriveTargets(media: MediaInfo): TargetDefaults {
  let container = deriveContainer(media)
  let videoCodec = deriveVideoCodec(media)
  if (!isVideoCodecSupported(container, videoCodec)) {
    container = 'mkv'
  }
  let audioCodec = deriveAudioCodec(container)
  if (!isAudioCodecSupported(container, audioCodec)) audioCodec = 'aac'
  const audioMode: AudioMode = media.audio ? 'encode' : 'none'
  return { container, videoCodec, audioCodec, audioMode }
}

export interface BuildSpecParams {
  media: MediaInfo
  estimate: EstimateResult
  audioMode: AudioMode
  audioCodec: AudioCodec
  outputDirectory: string | null
  nameTemplate: string
  conflict: JobSpec['output']['conflict']
  preset?: string | null
  hwAccel?: boolean
  extraArgs?: string[]
  /** 高级模式覆盖项（字段存在即生效）。 */
  videoOverride?: Partial<JobSpec['video']>
  audioOverride?: Partial<JobSpec['audio']>
  keepMetadata?: boolean
  keepChapters?: boolean
}

/** 组装 JobSpec。 */
export function buildJobSpec(params: BuildSpecParams): JobSpec {
  const { media, estimate } = params
  const video: JobSpec['video'] = {
    codec: estimate.videoCodec,
    encoder: estimate.encoder,
    rateControl: estimate.rateControl,
    crf: estimate.crf,
    bitrateKbps: estimate.rateControl === 'crf' ? null : Math.round(estimate.videoBitrateKbps),
    width: estimate.scaledResolution ? estimate.width : null,
    height: estimate.scaledResolution ? estimate.height : null,
    frameRate: estimate.changedFrameRate ? estimate.frameRate : null,
    preset: params.preset ?? DEFAULT_PRESET,
    profile: null,
    level: null,
    pixelFormat: 'yuv420p',
    gop: null,
    bframes: null,
    hwAccel: params.hwAccel ?? false,
    ...(params.videoOverride ?? {})
  }

  const audio: JobSpec['audio'] = {
    mode: params.audioMode,
    codec: params.audioCodec,
    bitrateKbps:
      params.audioMode === 'encode'
        ? Math.max(1, Math.round(estimate.audioBitrateKbps || audioBitrateForQuality(params.audioCodec, estimate.quality)))
        : null,
    channels: estimate.audioChannels > 0 && estimate.audioChannels < 2 ? 1 : 0,
    sampleRate: params.audioMode === 'encode' ? estimate.audioSampleRate : null,
    ...(params.audioOverride ?? {})
  }

  void CONTAINER_INFO
  void media

  return {
    inputPath: media.path,
    container: estimate.container,
    video,
    audio,
    output: {
      directory: params.outputDirectory,
      nameTemplate: params.nameTemplate,
      conflict: params.conflict,
      keepMetadata: params.keepMetadata ?? true,
      keepChapters: params.keepChapters ?? true
    },
    extraArgs: params.extraArgs ?? []
  }
}

/** 输出路径预览（用于命令摘要与扩展名提示）。 */
export function previewOutputPath(spec: JobSpec, directory: string | null, fileName: string): string {
  const extension = CONTAINER_INFO[spec.container].extension
  const base = fileName.replace(/\.[^.]+$/, '')
  const dir = directory ?? spec.inputPath.replace(/[\\/][^\\/]+$/, '')
  return `${dir}/${base}_compressed.${extension}`.replace(/\\/g, '/')
}
