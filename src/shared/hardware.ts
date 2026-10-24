/**
 * 硬件加速判定（纯函数，渲染层与服务端共用）。
 *
 * 原则：
 * - 「自动」只有在**实测可用**时才走 GPU，否则回落 CPU；
 * - 「使用 GPU」在不可用时仍回落 CPU，但必须给出原因，绝不静默降级；
 * - 所有面向用户的文案都在这里集中生成，避免界面与服务端各说一套。
 */
import { CODEC_PROFILES, VIDEO_CODEC_LABELS } from './presets'
import type { HardwareStatus, HwAccelKind, HwMode, VideoCodec } from './types'

export type HwBackend = Exclude<HwAccelKind, 'none'>

/** 后端优先级：NVENC → QSV → AMF。 */
export const HW_BACKEND_ORDER: HwBackend[] = ['nvenc', 'qsv', 'amf']

export const HW_BACKEND_LABELS: Record<HwBackend, string> = {
  nvenc: 'NVIDIA NVENC',
  qsv: 'Intel Quick Sync',
  amf: 'AMD AMF'
}

/** 某编码族可尝试的硬件编码器（按后端优先级）。 */
export function hwEncodersForCodec(codec: VideoCodec): Array<{ kind: HwBackend; encoder: string }> {
  const map = CODEC_PROFILES[codec].hwEncoders
  const result: Array<{ kind: HwBackend; encoder: string }> = []
  for (const kind of HW_BACKEND_ORDER) {
    const encoder = map[kind]
    if (encoder) result.push({ kind, encoder })
  }
  return result
}

export interface HwAvailability {
  available: boolean
  encoder: string | null
  kind: HwBackend | null
  /** 面向用户的原因（可用时说明后端，不可用时说明为什么不可用）。 */
  reason: string
}

/** 查询某编码族是否有实测可用的硬件编码器。 */
export function gpuAvailability(status: HardwareStatus | null, codec: VideoCodec): HwAvailability {
  const codecLabel = VIDEO_CODEC_LABELS[codec]
  if (!status || status.state === 'idle') {
    return { available: false, encoder: null, kind: null, reason: '尚未检测硬件编码器，可点击「重新检测」' }
  }
  if (status.state === 'probing') {
    return { available: false, encoder: null, kind: null, reason: '正在检测硬件编码器…' }
  }

  const hit = status.usable.find((entry) => entry.codec === codec)
  if (hit) {
    return {
      available: true,
      encoder: hit.encoder,
      kind: hit.kind,
      reason: `已检测到 ${HW_BACKEND_LABELS[hit.kind]}（${hit.encoder}）`
    }
  }

  const attempted = status.tests.filter((test) => test.codec === codec)
  if (attempted.length === 0) {
    return {
      available: false,
      encoder: null,
      kind: null,
      reason: `当前 ffmpeg 未包含 ${codecLabel} 的硬件编码器`
    }
  }
  const failed = attempted.find((test) => !test.usable)
  return {
    available: false,
    encoder: null,
    kind: null,
    reason: failed ? failed.reason : `未检测到可用的 ${codecLabel} 硬件编码器`
  }
}

export interface AccelerationDecision {
  hwAccel: boolean
  encoder: string | null
  /** 「GPU（h264_nvenc）」或「CPU（libx264）」。 */
  label: string
  /** 实际计算方式：GPU / CPU。 */
  compute: 'gpu' | 'cpu'
  reason: string
}

/**
 * 把用户选择（自动 / CPU / GPU）解析为最终计算方式。
 *
 * `encoder` 只在 `hwAccel` 为 true 时有意义，用于估算与任务参数。
 */
export function resolveAcceleration(
  mode: HwMode,
  status: HardwareStatus | null,
  codec: VideoCodec
): AccelerationDecision {
  const profile = CODEC_PROFILES[codec]
  const availability = gpuAvailability(status, codec)

  if (mode === 'cpu') {
    return {
      hwAccel: false,
      encoder: null,
      label: `CPU（${profile.softwareEncoder}）`,
      compute: 'cpu',
      reason: '已手动选择使用 CPU 编码'
    }
  }

  if (availability.available && availability.encoder) {
    return {
      hwAccel: true,
      encoder: availability.encoder,
      label: `GPU（${availability.encoder}）`,
      compute: 'gpu',
      reason: availability.reason
    }
  }

  const prefix = mode === 'gpu' ? 'GPU 不可用，已回退 CPU' : '未检测到可用的 GPU，使用 CPU'
  return {
    hwAccel: false,
    encoder: null,
    label: `CPU（${profile.softwareEncoder}）`,
    compute: 'cpu',
    reason: `${prefix}：${availability.reason}`
  }
}

/** 编码器 → 「GPU/CPU」展示文案。 */
export function describeEncoder(encoder: string): string {
  return `${encoder}（${/_nvenc$|_qsv$|_amf$|_vaapi$|_videotoolbox$/.test(encoder) ? 'GPU' : 'CPU'}）`
}
