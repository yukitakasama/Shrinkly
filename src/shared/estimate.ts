/**
 * 参数计算：质量 → CRF / 码率 / 分辨率 / 帧率 / 音频。
 *
 * 纯函数，不依赖 Electron；渲染层用它做实时预览，主进程在启动任务前用**同一个函数**
 * 重新计算，保证「界面显示」与「实际执行」永不脱节。规则来源见 PLAN.md §5。
 */
import {
  CODEC_PROFILES,
  MIN_RESOLUTION_SHORT_SIDE,
  RESOLUTION_HEIGHTS,
  audioBitrateForQuality,
  bppForQuality,
  clampQuality,
  crfForQuality,
  preferredEncoder,
  qualityLabel
} from './presets'
import type {
  AudioMode,
  AudioOptions,
  EstimateInput,
  EstimateResult,
  JobError,
  MediaInfo,
  RateControl,
  VideoCodec,
  VideoOptions
} from './types'

/** 容器开销系数（约 2%）。 */
const CONTAINER_OVERHEAD = 1.02
/** 目标体积模式的码率冗余系数。 */
const TARGET_SIZE_FACTOR = 0.97
/** 源码率封顶倍数：估算超过源码率 2 倍时封顶，避免小体积源被「放大」。 */
const SOURCE_BITRATE_CAP = 2
/** 目标体积模式下帧率可退让的候选值。 */
const FRAME_RATE_FALLBACKS = [60, 30, 24]

export interface ResolutionDecision {
  width: number
  height: number
  changed: boolean
  /** 面向用户的说明。 */
  reason: string
}

export interface FrameRateDecision {
  frameRate: number
  changed: boolean
  reason: string
}

interface AudioEstimate {
  bitrateKbps: number
  channels: number
  sampleRate: number | null
  notes: string[]
}

function evenize(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2)
}

/** 给定分辨率 / 帧率 / 编码器的「可接受最低码率」（bit/s）。 */
export function requiredBitrateBps(width: number, height: number, frameRate: number, codec: VideoCodec): number {
  const profile = CODEC_PROFILES[codec]
  return profile.minBpp * width * height * frameRate
}

/**
 * 以「短边」为档位基准换算实际宽高（保持宽高比，宽高取偶）。
 *
 * 1080p 在横屏即高度 1080，在竖屏则指短边 1080（例如 1080×1920），符合 PLAN §5.4
 * 「按短边判定档位」的约定。
 */
function scaleToShortSide(sourceWidth: number, sourceHeight: number, shortSide: number): { width: number; height: number } {
  const landscape = sourceWidth >= sourceHeight
  if (landscape) {
    const height = evenize(shortSide)
    const width = evenize((sourceWidth / sourceHeight) * height)
    return { width, height }
  }
  const width = evenize(shortSide)
  const height = evenize((sourceHeight / sourceWidth) * width)
  return { width, height }
}

/**
 * 选择目标分辨率（PLAN §5.4）。
 *
 * - 只降不升；
 * - 在给定码率下，取满足 minBpp 约束的最大候选档位；
 * - 短边不低于 360（源本身更小时保持源）；
 * - 源档位与候选档位相差 <10% 时保持源分辨率，避免无意义重采样。
 */
export function selectResolution(params: {
  sourceWidth: number
  sourceHeight: number
  frameRate: number
  videoBitrateKbps: number
  codec: VideoCodec
}): ResolutionDecision {
  const { sourceWidth, sourceHeight, frameRate, videoBitrateKbps, codec } = params
  const width = evenize(Math.max(2, Math.round(sourceWidth)))
  const height = evenize(Math.max(2, Math.round(sourceHeight)))
  const shortSide = Math.min(width, height)
  const bitrateBps = videoBitrateKbps * 1000

  const keepSource = (reason: string): ResolutionDecision => ({ width, height, changed: false, reason })

  if (shortSide <= MIN_RESOLUTION_SHORT_SIDE) {
    return keepSource('源分辨率已处于下限档位，保持原尺寸')
  }

  // 当前码率足以支撑源分辨率时直接保持，避免无意义重采样。
  if (bitrateBps >= requiredBitrateBps(width, height, frameRate, codec)) {
    return keepSource(`${formatMbps(videoBitrateKbps)} 足以支撑 ${describeSize(width, height)}${Math.round(frameRate)}fps，保持源分辨率`)
  }

  const candidates = RESOLUTION_HEIGHTS.filter((candidate) => candidate < shortSide)

  for (const candidate of candidates) {
    const scaled = scaleToShortSide(width, height, candidate)
    if (bitrateBps >= requiredBitrateBps(scaled.width, scaled.height, frameRate, codec)) {
      if ((shortSide - candidate) / shortSide < 0.1) {
        return keepSource('候选档位与源分辨率差距不足 10%，保持原尺寸')
      }
      return {
        width: scaled.width,
        height: scaled.height,
        changed: true,
        reason: `码率 ${formatMbps(videoBitrateKbps)} 不足以支撑 ${describeSize(width, height)}${Math.round(frameRate)}fps，降到 ${describeSize(scaled.width, scaled.height)}`
      }
    }
  }

  // 所有候选都不满足：退到下限档，仍保持「不升采样」原则。
  const floorShortSide = Math.max(Math.min(MIN_RESOLUTION_SHORT_SIDE, shortSide), 2)
  const floor = scaleToShortSide(width, height, floorShortSide)
  if (Math.min(floor.width, floor.height) < shortSide) {
    return {
      width: floor.width,
      height: floor.height,
      changed: true,
      reason: `码率 ${formatMbps(videoBitrateKbps)} 偏紧，已降到下限 ${describeSize(floor.width, floor.height)}`
    }
  }
  return keepSource('已处于分辨率下限，保持原尺寸')
}

/**
 * 选择目标帧率（PLAN §5.5）。
 *
 * 质量模式：源 ≤60fps 保持不变；>60fps 时上限 60，若码率不足以支撑 60fps 则降到 30。
 * 目标体积模式：允许在分辨率触底后继续降到 30 / 24fps。
 */
export function selectFrameRate(params: {
  sourceFrameRate: number
  width: number
  height: number
  videoBitrateKbps: number
  codec: VideoCodec
  allowBelow30: boolean
}): FrameRateDecision {
  const { sourceFrameRate, width, height, videoBitrateKbps, codec, allowBelow30 } = params
  const source = Number.isFinite(sourceFrameRate) && sourceFrameRate > 0 ? sourceFrameRate : 30
  const candidates = FRAME_RATE_FALLBACKS.filter((value) => value <= source && (allowBelow30 || value >= 30))
  const bitrateBps = videoBitrateKbps * 1000

  if (source <= 60) {
    if (candidates.length === 0) return { frameRate: source, changed: false, reason: '保持源帧率' }
    for (const candidate of candidates) {
      if (candidate === source) break
      if (bitrateBps >= requiredBitrateBps(width, height, candidate, codec) * 1.2) {
        return { frameRate: candidate, changed: true, reason: `码率 ${formatMbps(videoBitrateKbps)} 偏紧，帧率从 ${Math.round(source)}fps 降到 ${candidate}fps` }
      }
    }
    return { frameRate: source, changed: false, reason: `保持源帧率 ${formatFps(source)}` }
  }

  // 源为高帧率（>60fps）：上限 60。
  const cap = 60
  const required60 = requiredBitrateBps(width, height, cap, codec)
  if (bitrateBps >= required60 * 1.2) {
    return { frameRate: cap, changed: true, reason: `源 ${formatFps(source)} 超过 60fps，按上限保留 60fps` }
  }
  const lower = allowBelow30 ? 24 : 30
  return { frameRate: lower, changed: true, reason: `源 ${formatFps(source)} 过高且码率有限，帧率降至 ${lower}fps` }
}

function formatMbps(kbps: number): string {
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(2)} Mbps`
  return `${Math.round(kbps)} kbps`
}

function formatFps(fps: number): string {
  const rounded = Math.round(fps * 100) / 100
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)}fps`
}

function describeSize(width: number, height: number): string {
  const longSide = Math.max(width, height)
  const known: Record<number, string> = { 2160: '4K', 1440: '1440p', 1080: '1080p', 720: '720p', 480: '480p', 360: '360p' }
  const label = known[longSide]
  return label ? `${label}(${width}×${height})` : `${width}×${height}`
}

function alignTo8(value: number): number {
  return Math.max(8, Math.round(value / 8) * 8)
}

function estimateAudio(input: EstimateInput, quality: number, durationSec: number | null): AudioEstimate {
  const audio = input.media.audio
  const notes: string[] = []

  if (input.audioMode === 'none') {
    notes.push('已选择移除音轨，输出将使用 -an')
    return { bitrateKbps: 0, channels: 0, sampleRate: null, notes }
  }

  const sourceKbps = audio && audio.bitRate ? audio.bitRate / 1000 : null

  if (input.audioMode === 'copy') {
    notes.push(sourceKbps ? `音轨直接复制（约 ${Math.round(sourceKbps)} kbps，不重新编码）` : '音轨直接复制（码率未知，不重新编码）')
    return {
      bitrateKbps: sourceKbps ? Math.round(sourceKbps) : 0,
      channels: audio && audio.channels ? Math.min(2, audio.channels) : 2,
      sampleRate: audio?.sampleRate ?? null,
      notes
    }
  }

  if (!audio) {
    notes.push('源文件没有音轨，输出将使用 -an')
    return { bitrateKbps: 0, channels: 0, sampleRate: null, notes }
  }

  let targetKbps = input.audioCodec === 'flac' ? 0 : audioBitrateForQuality(input.audioCodec, quality)
  if (input.audioCodec === 'flac') {
    notes.push('FLAC 为无损编码，体积取决于源内容，未计入码率估算')
  } else if (sourceKbps && sourceKbps < targetKbps * 1.1) {
    const aligned = alignTo8(Math.min(targetKbps, sourceKbps))
    if (aligned !== targetKbps) {
      notes.push(`源音频仅 ${Math.round(sourceKbps)} kbps，取 ${aligned} kbps 避免无意义膨胀`)
    }
    targetKbps = aligned
  }

  const sourceChannels = audio.channels ?? 2
  const channels = Math.min(2, Math.max(1, sourceChannels))
  if (sourceChannels > 2) {
    notes.push(`源音频为 ${sourceChannels} 声道，输出降为立体声（-ac 2）`)
  }

  const sampleRate = audio.sampleRate && audio.sampleRate > 48000 ? 48000 : (audio.sampleRate ?? 48000)
  if (audio.sampleRate && audio.sampleRate > 48000) {
    notes.push(`源采样率 ${audio.sampleRate} Hz 超过 48 kHz，重采样到 48000 Hz`)
  }

  if (targetKbps > 0) {
    notes.push(`音频重编码为 ${input.audioCodec.toUpperCase()} ${targetKbps} kbps / ${channels} 声道`)
  }

  void durationSec
  return { bitrateKbps: targetKbps, channels, sampleRate, notes }
}

function errorResult(
  input: EstimateInput,
  error: JobError,
  partial: Partial<EstimateResult> = {}
): EstimateResult {
  const video = input.media.video
  return {
    ok: false,
    error,
    container: input.container,
    videoCodec: input.videoCodec,
    encoder: preferredEncoder(input.videoCodec, input.hwAccel),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    sourceWidth: video?.width ?? 0,
    sourceHeight: video?.height ?? 0,
    scaledResolution: false,
    frameRate: video?.frameRate ?? 0,
    sourceFrameRate: video?.frameRate ?? 0,
    changedFrameRate: false,
    durationSec: input.media.durationSec,
    videoBitrateKbps: 0,
    audioBitrateKbps: 0,
    totalBitrateKbps: 0,
    estimatedBytes: 0,
    ratio: 0,
    crf: null,
    rateControl: 'crf',
    quality: clampQuality(input.quality),
    targetSizeMB: input.targetSizeMB,
    minimumSizeMB: null,
    audioChannels: 0,
    audioSampleRate: null,
    explanations: [],
    ...partial
  }
}

/** 目标体积模式下计算「最小可达体积」（MB）。 */
function minimumAchievableMB(params: {
  sourceWidth: number
  sourceHeight: number
  audioKbps: number
  codec: VideoCodec
  durationSec: number
}): number {
  const { sourceWidth, sourceHeight, audioKbps, codec, durationSec } = params
  const profile = CODEC_PROFILES[codec]
  const shortSide = Math.min(sourceWidth, sourceHeight)
  const floorShortSide = Math.max(2, Math.min(shortSide, MIN_RESOLUTION_SHORT_SIDE))
  const floor = scaleToShortSide(sourceWidth, sourceHeight, floorShortSide)
  const minVideoBps = Math.max(
    profile.minBitrateKbps * 1000,
    requiredBitrateBps(floor.width, floor.height, 24, codec)
  )
  const bytes = ((minVideoBps + audioKbps * 1000) * durationSec) / 8 * CONTAINER_OVERHEAD
  return Math.round((bytes / (1024 * 1024)) * 10) / 10
}

/**
 * 计算一次完整估算。质量模式与目标体积模式共用同一条流水线，差异只在码率来源。
 */
export function computeEstimate(input: EstimateInput): EstimateResult {
  const media: MediaInfo = input.media
  const video = media.video
  if (!video || video.width < 16 || video.height < 16) {
    return errorResult(input, {
      code: 'NO_VIDEO_STREAM',
      title: '未找到有效的视频流',
      detail: 'ffprobe 未能从该文件中解析出可用的视频流。',
      hint: '请确认文件未被截断或加密；纯音频文件请改用音频工具处理。'
    })
  }

  const quality = clampQuality(input.quality)
  const profile = CODEC_PROFILES[input.videoCodec]
  const encoder = preferredEncoder(input.videoCodec, input.hwAccel)
  const sourceFps = video.frameRate > 0 ? video.frameRate : 30
  const durationSec = media.durationSec && media.durationSec > 0 ? media.durationSec : null
  const audio = estimateAudio(input, quality, durationSec)
  const explanations: string[] = []
  const targetMode = input.targetSizeMB !== null && input.targetSizeMB !== undefined

  if (!targetMode && !durationSec) {
    explanations.push('未能获取源时长，预计体积不可用（仍可正常转换）')
  }

  let rateControl: RateControl = 'crf'
  let crf: number | null = null
  let videoBitrateKbps: number
  let selectedWidth = video.width
  let selectedHeight = video.height
  let selectedFps = sourceFps
  let scaledResolution = false
  let changedFrameRate = false

  if (targetMode) {
    const targetMB = input.targetSizeMB as number
    if (!durationSec) {
      return errorResult(input, {
        code: 'DURATION_UNKNOWN',
        title: '无法确定源时长',
        detail: '目标体积模式需要精确时长来反解码率，此文件的 ffprobe 信息缺少 duration。',
        hint: '请改用质量模式（滑块），或先修复源文件的时间戳。'
      })
    }
    const totalBps = ((targetMB * 1024 * 1024 * 8) / durationSec) * TARGET_SIZE_FACTOR
    const audioBps = audio.bitrateKbps * 1000
    let videoBps = totalBps - audioBps

    const minVideoBps = profile.minBitrateKbps * 1000
    if (videoBps < minVideoBps) {
      const minimum = minimumAchievableMB({
        sourceWidth: video.width,
        sourceHeight: video.height,
        audioKbps: audio.bitrateKbps,
        codec: input.videoCodec,
        durationSec
      })
      return errorResult(
        input,
        {
          code: 'TARGET_UNREACHABLE',
          title: '目标体积过小，无法达成',
          detail: `目标 ${targetMB} MB 反解出的视频码率仅 ${Math.max(0, Math.round(videoBps / 1000))} kbps，低于 ${input.videoCodec.toUpperCase()} 的可用下限 ${profile.minBitrateKbps} kbps。`,
          hint: `该源在当前设置下最小可达约 ${minimum} MB，请把目标体积调高到 ${minimum} MB 以上。`
        },
        { minimumSizeMB: minimum }
      )
    }

    const resolution = selectResolution({
      sourceWidth: video.width,
      sourceHeight: video.height,
      frameRate: sourceFps,
      videoBitrateKbps: videoBps / 1000,
      codec: input.videoCodec
    })
    selectedWidth = resolution.width
    selectedHeight = resolution.height
    scaledResolution = resolution.changed

    const fpsDecision = selectFrameRate({
      sourceFrameRate: sourceFps,
      width: selectedWidth,
      height: selectedHeight,
      videoBitrateKbps: videoBps / 1000,
      codec: input.videoCodec,
      allowBelow30: true
    })
    selectedFps = fpsDecision.frameRate
    changedFrameRate = selectedFps !== sourceFps

    if (videoBps < requiredBitrateBps(selectedWidth, selectedHeight, selectedFps, input.videoCodec)) {
      const minimum = minimumAchievableMB({
        sourceWidth: video.width,
        sourceHeight: video.height,
        audioKbps: audio.bitrateKbps,
        codec: input.videoCodec,
        durationSec
      })
      return errorResult(
        input,
        {
          code: 'TARGET_UNREACHABLE',
          title: '目标体积过小，无法达成',
          detail: `即使降到 ${describeSize(selectedWidth, selectedHeight)}${selectedFps}fps，${formatMbps(videoBps / 1000)} 仍低于该编码器的画质底线。`,
          hint: `该源最小可达约 ${minimum} MB，请把目标体积调高。`
        },
        { minimumSizeMB: minimum }
      )
    }

    videoBitrateKbps = videoBps / 1000
    rateControl = 'abr'
    crf = null

    explanations.push(`目标体积 ${targetMB} MB / 时长 ${formatDuration(durationSec)} → 总码率 ${formatMbps(totalBps / 1000)}`)
    explanations.push(`扣除音频 ${Math.round(audio.bitrateKbps)} kbps 后，视频码率 ${formatMbps(videoBitrateKbps)}`)
    explanations.push(resolution.reason)
    explanations.push(fpsDecision.reason)
    explanations.push('目标体积模式使用单遍 ABR（-b:v/-maxrate/-bufsize）以保证体积收敛')
  } else {
    // 先定帧率（>60fps 时按 bpp 余量决定 60 还是 30），再按最终帧率算码率与分辨率，
    // 保证「估算码率」与「实际输出帧率」一致。
    let qualityFps = sourceFps
    let fpsReason: string
    if (sourceFps > 60) {
      const headroom = (bppForQuality(quality) * profile.efficiency) / profile.minBpp
      qualityFps = headroom < 1.2 ? 30 : 60
      fpsReason =
        qualityFps === 60
          ? `源 ${formatFps(sourceFps)} 超过 60fps，按上限输出 60fps`
          : `源 ${formatFps(sourceFps)} 过高且当前质量档位码率有限，帧率降到 30fps`
    } else {
      fpsReason = `保持源帧率 ${formatFps(sourceFps)}`
    }
    selectedFps = qualityFps
    changedFrameRate = qualityFps !== sourceFps

    const sourceBps = video.bitRate && video.bitRate > 0 ? video.bitRate : null
    const rawBps = video.width * video.height * qualityFps * bppForQuality(quality) * profile.efficiency
    const cappedBps = sourceBps ? Math.min(rawBps, sourceBps * SOURCE_BITRATE_CAP) : rawBps
    if (sourceBps && rawBps > cappedBps) {
      explanations.push(
        `按质量档位推算需 ${formatMbps(rawBps / 1000)}，已封顶到源码率的 ${SOURCE_BITRATE_CAP} 倍（${formatMbps(cappedBps / 1000)}），避免体积反增`
      )
    }

    const resolution = selectResolution({
      sourceWidth: video.width,
      sourceHeight: video.height,
      frameRate: qualityFps,
      videoBitrateKbps: cappedBps / 1000,
      codec: input.videoCodec
    })
    selectedWidth = resolution.width
    selectedHeight = resolution.height
    scaledResolution = resolution.changed

    // 下调分辨率后按新像素数重算码率（保持闭环一致）。
    const scaledBps = selectedWidth * selectedHeight * qualityFps * bppForQuality(quality) * profile.efficiency
    videoBitrateKbps = (sourceBps ? Math.min(scaledBps, sourceBps * SOURCE_BITRATE_CAP) : scaledBps) / 1000

    crf = input.hwAccel
      ? Math.min(profile.crfRange.max, crfForQuality(input.videoCodec, quality) + profile.hwCrfOffset)
      : crfForQuality(input.videoCodec, quality)
    rateControl = 'crf'

    explanations.push(
      `质量 ${quality}（${qualityLabel(quality)}）→ ${profile.softwareEncoder} ${input.hwAccel ? 'CQ' : 'CRF'} ${crf}` +
        (input.hwAccel ? '（硬件编码同画质需略高数值）' : '')
    )
    explanations.push(
      `码率估算：${describeSize(selectedWidth, selectedHeight)} × ${formatFps(selectedFps)} × ${bppForQuality(quality).toFixed(4)} bpp × ${profile.efficiency.toFixed(2)} ≈ ${formatMbps(videoBitrateKbps)}`
    )
    explanations.push(resolution.reason)
    explanations.push(fpsReason)
  }

  for (const note of audio.notes) explanations.push(note)

  const videoBytes = durationSec ? (videoBitrateKbps * 1000 * durationSec) / 8 : 0
  const audioBytes = durationSec ? (audio.bitrateKbps * 1000 * durationSec) / 8 : 0
  const estimatedBytes = durationSec ? Math.round((videoBytes + audioBytes) * CONTAINER_OVERHEAD) : 0
  const totalBitrateKbps = videoBitrateKbps + audio.bitrateKbps
  const ratio = estimatedBytes > 0 && media.sizeBytes > 0 ? estimatedBytes / media.sizeBytes : 0

  if (durationSec && estimatedBytes > 0) {
    explanations.push(
      `预计体积 ≈ ${(estimatedBytes / (1024 * 1024)).toFixed(1)} MB` +
        (ratio > 0 ? `（源 ${(media.sizeBytes / (1024 * 1024)).toFixed(1)} MB，压缩到 ${(ratio * 100).toFixed(0)}%）` : '')
    )
  }

  if (video.hdr) {
    explanations.push('源为 HDR，本工具不做 HDR→SDR 映射，输出可能偏色')
  }
  if (ratio >= 1 && durationSec) {
    explanations.push('预计输出不小于源文件，建议降低质量档位或改用目标体积模式')
  }

  return {
    ok: true,
    error: null,
    container: input.container,
    videoCodec: input.videoCodec,
    encoder,
    width: selectedWidth,
    height: selectedHeight,
    sourceWidth: video.width,
    sourceHeight: video.height,
    scaledResolution,
    frameRate: selectedFps,
    sourceFrameRate: sourceFps,
    changedFrameRate,
    durationSec,
    videoBitrateKbps,
    audioBitrateKbps: audio.bitrateKbps,
    totalBitrateKbps,
    estimatedBytes,
    ratio,
    crf,
    rateControl,
    quality,
    targetSizeMB: input.targetSizeMB,
    minimumSizeMB: null,
    audioChannels: audio.channels,
    audioSampleRate: audio.sampleRate,
    explanations
  }
}

/** 把估算结果转成 `VideoOptions`（供渲染层构造 JobSpec，主进程会再次校验）。 */
export function videoOptionsFromEstimate(estimate: EstimateResult, hwAccel: boolean): VideoOptions {
  return {
    codec: estimate.videoCodec,
    encoder: estimate.encoder,
    rateControl: estimate.rateControl,
    crf: estimate.crf,
    bitrateKbps: estimate.rateControl === 'crf' ? null : Math.round(estimate.videoBitrateKbps),
    width: estimate.scaledResolution ? estimate.width : null,
    height: estimate.scaledResolution ? estimate.height : null,
    frameRate: estimate.changedFrameRate ? estimate.frameRate : null,
    preset: null,
    profile: null,
    level: null,
    pixelFormat: null,
    gop: null,
    bframes: null,
    hwAccel
  }
}

/** 把估算结果转成 `AudioOptions`。 */
export function audioOptionsFromEstimate(estimate: EstimateResult, mode: AudioMode, codec: AudioOptions['codec']): AudioOptions {
  if (mode !== 'encode') {
    return { mode, codec, bitrateKbps: null, channels: 0, sampleRate: null }
  }
  return {
    mode,
    codec,
    bitrateKbps: estimate.audioBitrateKbps > 0 ? Math.round(estimate.audioBitrateKbps) : null,
    channels: estimate.audioChannels > 0 && estimate.audioChannels < 2 ? 1 : 0,
    sampleRate: estimate.audioSampleRate ?? null
  }
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
