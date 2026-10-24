/**
 * FFmpeg 参数构造（纯函数，可单元测试）。
 *
 * 规则来源 PLAN §4.4 / §4.5：
 * - 参数一律以数组传递，绝不拼接 shell 字符串；
 * - 容器与编码的硬约束在此最后兜底（`validateJobSpec` 已提前拦截）；
 * - `copy` 音轨时不得再带 `-b:a/-ac/-ar`。
 */
import {
  AUDIO_ENCODER,
  CODEC_PROFILES,
  CONTAINER_MUXER,
  DEFAULT_PRESET,
  HW_PRESET_MAP,
  hwBackendOf,
  isHardwareEncoder
} from '../../shared/presets'
import type { JobSpec, MediaInfo } from '../../shared/types'

export interface BuildArgsOptions {
  spec: JobSpec
  /** 输入文件绝对路径。 */
  input: string
  /** 输出文件路径（通常为 `.part` 临时文件）。 */
  output: string
  /** 硬件编码时用于限制码率上限（kbps），避免 CQ 模式码率失控。 */
  bitrateCapKbps?: number | null
  /** 两遍编码的编号：1 = 第一遍（丢弃输出），2 = 第二遍。 */
  pass?: 1 | 2 | null
  /** 是否附加 `-progress pipe:1 -nostats`（运行与预览保持一致）。 */
  includeProgress?: boolean
  /** 两遍编码的统计文件名前缀。 */
  passLogFile?: string | null
  /** 源信息（用于隔行 / 10bit 等判断）。 */
  media?: MediaInfo | null
}

const IS_WINDOWS = process.platform === 'win32'

/** QSV 只接受 veryfast 及更慢的预设，超快档位统一折到 veryfast。 */
const QSV_PRESET_MAP: Record<string, string> = {
  ultrafast: 'veryfast',
  superfast: 'veryfast',
  veryfast: 'veryfast',
  faster: 'faster',
  fast: 'fast',
  medium: 'medium',
  slow: 'slow',
  slower: 'slower',
  veryslow: 'veryslow'
}

/** AMF 只有三档质量预设。 */
const AMF_QUALITY_MAP: Record<string, string> = {
  ultrafast: 'speed',
  superfast: 'speed',
  veryfast: 'speed',
  faster: 'speed',
  fast: 'speed',
  medium: 'balanced',
  slow: 'quality',
  slower: 'quality',
  veryslow: 'quality'
}

/** 构造完整的 ffmpeg 参数数组。 */
export function buildFfmpegArgs(options: BuildArgsOptions): string[] {
  const { spec, input, output } = options
  const { video, audio, output: outputOptions, container } = spec
  const args: string[] = ['-hide_banner', '-nostdin', '-y', '-i', input]

  args.push('-map', '0:v:0')
  if (audio.mode !== 'none') args.push('-map', '0:a?')
  args.push('-map_metadata', outputOptions.keepMetadata ? '0' : '-1')
  args.push('-map_chapters', outputOptions.keepChapters ? '0' : '-1')

  // ---------------- 视频 ----------------
  const encoder = video.encoder ?? CODEC_PROFILES[video.codec].softwareEncoder
  const profile = CODEC_PROFILES[video.codec]
  const hardware = isHardwareEncoder(encoder)
  const backend = hardware ? hwBackendOf(encoder) : 'none'
  args.push('-c:v', encoder)

  if (video.rateControl === 'crf') {
    const crf = video.crf ?? 23
    if (backend === 'nvenc') {
      args.push('-rc', 'vbr', '-cq', String(crf))
      if (options.bitrateCapKbps && options.bitrateCapKbps > 0) {
        args.push('-b:v', `${Math.round(options.bitrateCapKbps)}k`)
      }
    } else if (backend === 'qsv') {
      // QSV 用 global_quality 表达「恒定质量」。
      args.push('-global_quality', String(crf))
      if (options.bitrateCapKbps && options.bitrateCapKbps > 0) {
        args.push('-b:v', `${Math.round(options.bitrateCapKbps)}k`)
      }
    } else if (backend === 'amf') {
      // AMF 用 CQP 表达恒定质量（I / P 帧取同一值）。
      args.push('-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf))
      if (options.bitrateCapKbps && options.bitrateCapKbps > 0) {
        args.push('-b:v', `${Math.round(options.bitrateCapKbps)}k`)
      }
    } else {
      args.push('-crf', String(crf))
      // libvpx / libaom 的恒定质量模式需要把目标码率置 0。
      if (video.codec === 'vp9' || video.codec === 'av1') args.push('-b:v', '0')
    }
  } else {
    const bitrate = video.bitrateKbps ?? profile.minBitrateKbps
    args.push('-b:v', `${Math.round(bitrate)}k`)
    args.push('-maxrate', `${Math.round(bitrate * 1.5)}k`)
    args.push('-bufsize', `${Math.round(bitrate * 2)}k`)
    if (video.rateControl === 'pass2' && options.pass) {
      args.push('-pass', String(options.pass))
      args.push('-passlogfile', options.passLogFile ?? 'shrinkly-pass')
    }
  }

  // 预设 / cpu-used
  const preset = video.preset ?? DEFAULT_PRESET
  if (backend === 'nvenc') {
    args.push('-preset', HW_PRESET_MAP[preset] ?? 'p5')
  } else if (backend === 'qsv') {
    args.push('-preset', QSV_PRESET_MAP[preset] ?? 'medium')
  } else if (backend === 'amf') {
    args.push('-quality', AMF_QUALITY_MAP[preset] ?? 'balanced')
  } else if (video.codec === 'h264' || video.codec === 'hevc') {
    args.push('-preset', preset)
  } else if (profile.cpuUsed !== null) {
    args.push('-cpu-used', String(profile.cpuUsed))
  }
  if (!hardware && profile.extraArgs.length > 0) args.push(...profile.extraArgs)

  if (video.profile) args.push('-profile:v', video.profile)
  if (video.level) args.push('-level', video.level)
  if (video.pixelFormat) args.push('-pix_fmt', video.pixelFormat)
  if (video.gop !== null && video.gop !== undefined) args.push('-g', String(video.gop))
  if (video.bframes !== null && video.bframes !== undefined) args.push('-bf', String(video.bframes))

  if (video.width && video.height) {
    args.push('-vf', `scale=${video.width}:${video.height}:flags=lanczos`)
  }
  if (video.frameRate) {
    args.push('-r', String(video.frameRate))
    args.push('-fps_mode', 'cfr')
  }

  // ---------------- 音频 ----------------
  // 两遍编码的第一遍不产出音频，避免无谓计算。
  if (options.pass === 1) {
    args.push('-an')
  } else if (audio.mode === 'none') {
    args.push('-an')
  } else if (audio.mode === 'copy') {
    args.push('-c:a', 'copy')
  } else {
    args.push('-c:a', AUDIO_ENCODER[audio.codec])
    if (audio.bitrateKbps && audio.codec !== 'flac') args.push('-b:a', `${Math.round(audio.bitrateKbps)}k`)
    if (audio.channels > 0) args.push('-ac', String(audio.channels))
    if (audio.sampleRate) args.push('-ar', String(audio.sampleRate))
  }

  // ---------------- 容器 ----------------
  if (container === 'mp4' || container === 'mov') {
    args.push('-movflags', '+faststart')
    if (video.codec === 'hevc') args.push('-tag:v', 'hvc1')
    args.push('-avoid_negative_ts', 'make_zero')
  }
  args.push('-f', CONTAINER_MUXER[container])

  if (spec.extraArgs.length > 0) args.push(...spec.extraArgs)

  if (options.includeProgress !== false) {
    args.push('-progress', 'pipe:1', '-nostats')
  }

  if (options.pass === 1) {
    args.push('-f', 'null', IS_WINDOWS ? 'NUL' : '/dev/null')
    return args
  }

  args.push(output)
  return args
}

/** 生成可复制的命令行（仅用于展示，实际执行始终用数组）。 */
export function formatCommandForDisplay(args: string[]): string {
  return args
    .map((arg) => {
      if (arg.length === 0) return '""'
      if (/[\s"'&|<>^]/.test(arg)) return `"${arg.replace(/"/g, '\\"')}"`
      return arg
    })
    .join(' ')
}
