import { describe, expect, it } from 'vitest'
import {
  HW_BACKEND_ORDER,
  describeEncoder,
  gpuAvailability,
  hwEncodersForCodec,
  resolveAcceleration
} from '../../src/shared/hardware'
import type { HardwareStatus, VideoCodec } from '../../src/shared/types'

function makeStatus(overrides: Partial<HardwareStatus> = {}): HardwareStatus {
  return {
    state: 'ready',
    tests: [],
    usable: [],
    message: '未检测到可用的硬件编码器，将使用 CPU 编码',
    probedAt: 1,
    ...overrides
  }
}

describe('硬件编码器候选', () => {
  it('按 NVENC → QSV → AMF 的顺序给出候选', () => {
    expect(HW_BACKEND_ORDER).toEqual(['nvenc', 'qsv', 'amf'])
    const candidates = hwEncodersForCodec('h264')
    expect(candidates.map((item) => item.encoder)).toEqual(['h264_nvenc', 'h264_qsv', 'h264_amf'])
  })

  it('每个编码族都有候选编码器 id', () => {
    for (const codec of ['h264', 'hevc', 'av1', 'vp9'] as VideoCodec[]) {
      expect(hwEncodersForCodec(codec).length).toBeGreaterThan(0)
    }
  })
})

describe('gpuAvailability', () => {
  it('尚未检测时明确说明，而不是假装可用', () => {
    const result = gpuAvailability(null, 'h264')
    expect(result.available).toBe(false)
    expect(result.reason).toContain('尚未检测')
  })

  it('检测中时提示正在检测', () => {
    const result = gpuAvailability(makeStatus({ state: 'probing' }), 'h264')
    expect(result.available).toBe(false)
    expect(result.reason).toContain('正在检测')
  })

  it('实测可用时返回编码器与后端', () => {
    const status = makeStatus({
      usable: [{ codec: 'h264', encoder: 'h264_qsv', kind: 'qsv' }],
      tests: [{ codec: 'h264', encoder: 'h264_qsv', kind: 'qsv', usable: true, reason: '' }]
    })
    const result = gpuAvailability(status, 'h264')
    expect(result.available).toBe(true)
    expect(result.encoder).toBe('h264_qsv')
    expect(result.kind).toBe('qsv')
    expect(result.reason).toContain('Intel Quick Sync')
  })

  it('没有该编码族的实测项时说明 ffmpeg 未编译该编码器', () => {
    const result = gpuAvailability(makeStatus(), 'av1')
    expect(result.available).toBe(false)
    expect(result.reason).toContain('未包含')
  })

  it('实测失败时把失败原因透传', () => {
    const status = makeStatus({
      tests: [{ codec: 'hevc', encoder: 'hevc_nvenc', kind: 'nvenc', usable: false, reason: 'hevc_nvenc 初始化失败：驱动过旧' }]
    })
    expect(gpuAvailability(status, 'hevc').reason).toBe('hevc_nvenc 初始化失败：驱动过旧')
  })
})

describe('resolveAcceleration', () => {
  const usableStatus = makeStatus({
    usable: [{ codec: 'h264', encoder: 'h264_nvenc', kind: 'nvenc' }],
    tests: [{ codec: 'h264', encoder: 'h264_nvenc', kind: 'nvenc', usable: true, reason: '' }]
  })

  it('自动模式在 GPU 可用时使用 GPU', () => {
    const decision = resolveAcceleration('auto', usableStatus, 'h264')
    expect(decision.compute).toBe('gpu')
    expect(decision.hwAccel).toBe(true)
    expect(decision.encoder).toBe('h264_nvenc')
    expect(decision.label).toContain('GPU')
  })

  it('自动模式在 GPU 不可用时使用 CPU，并说明原因', () => {
    const decision = resolveAcceleration('auto', makeStatus(), 'h264')
    expect(decision.compute).toBe('cpu')
    expect(decision.hwAccel).toBe(false)
    expect(decision.label).toBe('CPU（libx264）')
    expect(decision.reason).toContain('使用 CPU')
  })

  it('手动选择 CPU 时即使 GPU 可用也不使用 GPU', () => {
    const decision = resolveAcceleration('cpu', usableStatus, 'h264')
    expect(decision.hwAccel).toBe(false)
    expect(decision.reason).toContain('手动选择')
  })

  it('强制 GPU 但不可用时回退 CPU，并把原因说清楚', () => {
    const decision = resolveAcceleration('gpu', makeStatus(), 'h264')
    expect(decision.hwAccel).toBe(false)
    expect(decision.reason).toContain('GPU 不可用，已回退 CPU')
  })

  it('AV1 只能使用对应的编码器', () => {
    const decision = resolveAcceleration('gpu', usableStatus, 'av1')
    expect(decision.hwAccel).toBe(false)
    expect(decision.label).toBe('CPU（libaom-av1）')
  })
})

describe('describeEncoder', () => {
  it('区分硬件与软件编码器', () => {
    expect(describeEncoder('h264_nvenc')).toBe('h264_nvenc（GPU）')
    expect(describeEncoder('libx264')).toBe('libx264（CPU）')
  })
})
