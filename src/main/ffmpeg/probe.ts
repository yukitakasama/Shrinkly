/**
 * ffprobe 调用与 JSON 解析。
 *
 * 解析逻辑抽成纯函数 `parseProbeJson`，便于用单元测试覆盖各种残缺/异常输入；
 * `probeFile` 只负责 spawn 与错误映射。
 */
import { stat } from 'node:fs/promises'
import type { MediaAudioStream, MediaInfo, MediaVideoStream } from '../../shared/types'
import { AppError } from './errors'
import { runCapture } from './exec'

/** ffprobe 输出的宽松结构（只声明用到的字段）。 */
export interface FfprobeStream {
  index?: number
  codec_name?: string
  codec_long_name?: string
  codec_type?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  bit_rate?: string
  pix_fmt?: string
  color_space?: string
  color_transfer?: string
  color_primaries?: string
  field_order?: string
  sample_aspect_ratio?: string
  display_aspect_ratio?: string
  duration?: string
  nb_frames?: string
  channels?: number
  sample_rate?: string
  tags?: Record<string, string>
  disposition?: Record<string, number>
}

export interface FfprobeJson {
  streams?: FfprobeStream[]
  format?: {
    duration?: string
    size?: string
    bit_rate?: string
    format_name?: string
    format_long_name?: string
  }
  chapters?: unknown[]
}

const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67'])

/** 解析形如 `30000/1001` 的帧率；无法解析返回 0。 */
export function parseFrameRate(value: string | undefined): number {
  if (!value) return 0
  const trimmed = value.trim()
  if (!trimmed || trimmed === '0/0') return 0
  if (trimmed.includes('/')) {
    const [numText, denText] = trimmed.split('/')
    const num = Number(numText)
    const den = Number(denText)
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0
    const fps = num / den
    return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : 0
  }
  const fps = Number(trimmed)
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : 0
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function isAttachedPicture(stream: FfprobeStream): boolean {
  return stream.disposition?.attached_pic === 1
}

/** 把 ffprobe JSON 转成 `MediaInfo`（纯函数）。 */
export function parseProbeJson(json: FfprobeJson, filePath: string, fallbackSize = 0): MediaInfo {
  const streams = Array.isArray(json.streams) ? json.streams : []
  const format = json.format ?? {}
  const videoStreams = streams.filter((stream) => stream.codec_type === 'video')
  const realVideoStreams = videoStreams.filter((stream) => !isAttachedPicture(stream))
  const audioStreams = streams.filter((stream) => stream.codec_type === 'audio')
  const subtitleStreams = streams.filter((stream) => stream.codec_type === 'subtitle')
  const warnings: string[] = []

  const primaryVideo = realVideoStreams[0] ?? null
  const primaryAudio = audioStreams[0] ?? null

  const formatDuration = parseNumber(format.duration)
  const videoDuration = primaryVideo ? parseNumber(primaryVideo.duration) : null
  const frameRate = primaryVideo
    ? parseFrameRate(primaryVideo.avg_frame_rate) || parseFrameRate(primaryVideo.r_frame_rate)
    : 0
  const frames = primaryVideo ? parseNumber(primaryVideo.nb_frames) : null
  const durationSec =
    (formatDuration && formatDuration > 0 ? formatDuration : null) ??
    (videoDuration && videoDuration > 0 ? videoDuration : null) ??
    (frames && frameRate > 0 ? frames / frameRate : null)

  const overallBitRate = parseNumber(format.bit_rate)
  const videoBitRateRaw = primaryVideo ? parseNumber(primaryVideo.bit_rate) : null
  const audioBitRateRaw = primaryAudio ? parseNumber(primaryAudio.bit_rate) : null

  // 码率缺失时的互补估算：format 总码率 - 另一路码率。
  let videoBitRate = videoBitRateRaw
  let audioBitRate = audioBitRateRaw
  if (!videoBitRate && overallBitRate && audioBitRateRaw && overallBitRate > audioBitRateRaw) {
    videoBitRate = overallBitRate - audioBitRateRaw
  }
  if (!audioBitRate && overallBitRate && videoBitRate && overallBitRate > videoBitRate) {
    audioBitRate = overallBitRate - videoBitRate
  }

  const hdr = Boolean(
    primaryVideo &&
      ((primaryVideo.color_transfer && HDR_TRANSFERS.has(primaryVideo.color_transfer)) ||
        (primaryVideo.color_primaries === 'bt2020' &&
          primaryVideo.color_transfer !== undefined &&
          HDR_TRANSFERS.has(primaryVideo.color_transfer)))
  )

  const video: MediaVideoStream | null = primaryVideo
    ? {
        index: primaryVideo.index ?? 0,
        codec: primaryVideo.codec_name ?? 'unknown',
        codecLongName: primaryVideo.codec_long_name ?? null,
        width: Math.max(0, Math.round(parseNumber(primaryVideo.width) ?? 0)),
        height: Math.max(0, Math.round(parseNumber(primaryVideo.height) ?? 0)),
        frameRate,
        bitRate: videoBitRate,
        pixelFormat: primaryVideo.pix_fmt ?? null,
        colorSpace: primaryVideo.color_space ?? null,
        colorTransfer: primaryVideo.color_transfer ?? null,
        colorPrimaries: primaryVideo.color_primaries ?? null,
        hdr,
        interlaced: Boolean(primaryVideo.field_order && !['progressive', 'unknown'].includes(primaryVideo.field_order)),
        sar: primaryVideo.sample_aspect_ratio ?? null,
        dar: primaryVideo.display_aspect_ratio ?? null,
        durationSec: videoDuration
      }
    : null

  const audio: MediaAudioStream | null = primaryAudio
    ? {
        index: primaryAudio.index ?? 0,
        codec: primaryAudio.codec_name ?? null,
        bitRate: audioBitRate,
        channels: parseNumber(primaryAudio.channels),
        sampleRate: parseNumber(primaryAudio.sample_rate),
        language: primaryAudio.tags?.language ?? null
      }
    : null

  if (!durationSec) warnings.push('无法读取时长，目标体积模式不可用')
  if (!primaryVideo) warnings.push('未检测到视频流')
  if (!primaryAudio) warnings.push('未检测到音轨，输出将不含音频')
  if (realVideoStreams.length > 1) warnings.push(`检测到 ${realVideoStreams.length} 路视频流，默认处理第一路`)
  if (videoStreams.length > realVideoStreams.length) warnings.push('已跳过封面图（attached_pic）流')
  if (audioStreams.length > 1) warnings.push(`检测到 ${audioStreams.length} 路音轨，默认保留第一路`)
  if (hdr) warnings.push('源为 HDR（PQ / HLG），本工具不做色调映射，颜色可能偏暗')
  if (video?.interlaced) warnings.push('源为隔行扫描视频，画质可能有轻微损失')
  if (!audioBitRate && audio) warnings.push('源音频码率未知，将按质量档位估算')

  return {
    path: filePath,
    fileName: filePath.split(/[\\/]/).pop() ?? filePath,
    container: format.format_name ?? null,
    formatLongName: format.format_long_name ?? null,
    durationSec,
    sizeBytes: parseNumber(format.size) ?? fallbackSize,
    overallBitRate,
    video,
    audio,
    videoStreamCount: realVideoStreams.length,
    audioStreamCount: audioStreams.length,
    subtitleStreamCount: subtitleStreams.length,
    chapterCount: Array.isArray(json.chapters) ? json.chapters.length : 0,
    warnings
  }
}

/** 调用 ffprobe 读取媒体信息。 */
export async function probeFile(ffprobePath: string, filePath: string, timeoutMs = 10_000): Promise<MediaInfo> {
  let sizeBytes = 0
  try {
    const info = await stat(filePath)
    if (!info.isFile()) {
      throw new AppError({
        code: 'NOT_A_FILE',
        title: '目标不是文件',
        detail: `${filePath} 不是普通文件。`,
        hint: '请拖入视频文件本身，而不是文件夹或设备。'
      })
    }
    sizeBytes = info.size
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError({
      code: 'FILE_NOT_FOUND',
      title: '找不到文件',
      detail: `无法访问 ${filePath}。`,
      hint: '请确认文件存在、路径无误，且当前用户有读取权限。'
    })
  }

  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', filePath]
  const result = await runCapture(ffprobePath, args, { timeoutMs })
  if (result.timedOut) {
    throw new AppError({
      code: 'PROBE_TIMEOUT',
      title: '读取媒体信息超时',
      detail: `ffprobe 在 ${Math.round(timeoutMs / 1000)} 秒内没有返回结果。`,
      hint: '文件可能位于响应缓慢的网络驱动器，请复制到本地磁盘后重试。'
    })
  }
  if (result.spawnError) {
    throw new AppError({
      code: 'PROBE_FAILED',
      title: '无法启动 ffprobe',
      detail: result.spawnError,
      hint: '请检查 ffprobe 路径是否正确，或改用「设置」中的自定义路径。'
    })
  }
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new AppError({
      code: 'PROBE_UNSUPPORTED',
      title: '无法识别媒体信息',
      detail: `ffprobe 未能解析该文件：\n${result.stderr.split(/\r?\n/).slice(-5).join('\n')}`,
      hint: '请确认这是一个未损坏的视频文件；如为特殊格式请先转成 MP4 / MKV。',
      raw: result.stderr.slice(-2000)
    })
  }

  let json: FfprobeJson
  try {
    json = JSON.parse(result.stdout) as FfprobeJson
  } catch {
    throw new AppError({
      code: 'PROBE_FAILED',
      title: '解析媒体信息失败',
      detail: 'ffprobe 输出的 JSON 无法解析。',
      hint: '请确认 ffprobe 版本与 ffmpeg 匹配。',
      raw: result.stdout.slice(0, 2000)
    })
  }

  return parseProbeJson(json, filePath, sizeBytes)
}
