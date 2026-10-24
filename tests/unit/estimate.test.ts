import { describe, expect, it } from 'vitest'
import { computeEstimate, requiredBitrateBps, selectResolution } from '../../src/shared/estimate'
import { crfForQuality, bppForQuality } from '../../src/shared/presets'
import type { VideoCodec } from '../../src/shared/types'
import { makeEstimateInput, makeMedia } from './fixtures'

const QUALITY_STEPS = [0, 20, 40, 60, 80, 100]

describe('质量档位与 CRF', () => {
  it('CRF 随质量提高而下降，且与 PLAN §5.1 的锚点一致', () => {
    const expectations: Record<VideoCodec, [number, number, number]> = {
      h264: [36, 24, 16],
      hevc: [34, 23, 15],
      vp9: [40, 26, 16],
      av1: [42, 26, 16]
    }
    for (const codec of Object.keys(expectations) as VideoCodec[]) {
      const [low, mid, high] = expectations[codec]
      expect(crfForQuality(codec, 0)).toBe(low)
      expect(crfForQuality(codec, 60)).toBe(mid)
      expect(crfForQuality(codec, 100)).toBe(high)
    }
  })

  it('bpp 随质量单调递增', () => {
    for (let i = 1; i < QUALITY_STEPS.length; i += 1) {
      expect(bppForQuality(QUALITY_STEPS[i])).toBeGreaterThan(bppForQuality(QUALITY_STEPS[i - 1]))
    }
  })

  it('1080p30 / q=60 / H.264 估算约 5.6 Mbps', () => {
    const result = computeEstimate(makeEstimateInput())
    expect(result.ok).toBe(true)
    expect(result.videoBitrateKbps).toBeGreaterThan(5200)
    expect(result.videoBitrateKbps).toBeLessThan(6000)
    expect(result.crf).toBe(24)
  })

  it('质量越高，视频码率越高（单调性）', () => {
    const bitrates = QUALITY_STEPS.map((quality) => computeEstimate(makeEstimateInput({ quality })).videoBitrateKbps)
    for (let i = 1; i < bitrates.length; i += 1) {
      expect(bitrates[i]).toBeGreaterThan(bitrates[i - 1])
    }
  })

  it('同质量下 HEVC / AV1 比 H.264 更省码率', () => {
    const h264 = computeEstimate(makeEstimateInput()).videoBitrateKbps
    const hevc = computeEstimate(makeEstimateInput({ videoCodec: 'hevc' })).videoBitrateKbps
    const av1 = computeEstimate(makeEstimateInput({ videoCodec: 'av1', container: 'mkv' })).videoBitrateKbps
    expect(hevc).toBeLessThan(h264)
    expect(av1).toBeLessThan(hevc)
  })

  it('硬件编码使用 CQ（CRF + 偏移）', () => {
    const software = computeEstimate(makeEstimateInput())
    const hardware = computeEstimate(makeEstimateInput({ hwAccel: true }))
    expect(hardware.encoder).toBe('h264_nvenc')
    expect(hardware.crf).toBe((software.crf ?? 0) + 2)
  })
})

describe('预计体积', () => {
  it('按 (视频码率 + 音频码率) × 时长 × 2% 容器开销计算', () => {
    const result = computeEstimate(makeEstimateInput())
    const expected = ((result.videoBitrateKbps + result.audioBitrateKbps) * 1000 * 100) / 8 * 1.02
    expect(result.estimatedBytes).toBeCloseTo(expected, -4)
    expect(result.ratio).toBeGreaterThan(0)
    expect(result.ratio).toBeLessThan(1)
  })

  it('源码率很低时封顶为源码率 2 倍，避免体积反增', () => {
    const result = computeEstimate(makeEstimateInput({ quality: 100, media: makeMedia({ videoBitRate: 500_000 }) }))
    expect(result.videoBitrateKbps).toBeLessThanOrEqual(1000 + 0.001)
    expect(result.scaledResolution).toBe(true)
    expect(result.explanations.some((text) => text.includes('封顶'))).toBe(true)
  })

  it('源时长未知时仍然可转换，只是体积未知', () => {
    const result = computeEstimate(makeEstimateInput({ media: makeMedia({ durationSec: null }) }))
    expect(result.ok).toBe(true)
    expect(result.estimatedBytes).toBe(0)
    expect(result.explanations.some((text) => text.includes('未能获取源时长'))).toBe(true)
  })
})

describe('目标体积模式', () => {
  it('20MB / 60s 的反解结果落在目标 ±8% 内', () => {
    const result = computeEstimate(
      makeEstimateInput({ targetSizeMB: 20, media: makeMedia({ durationSec: 60 }) })
    )
    expect(result.ok).toBe(true)
    const mb = result.estimatedBytes / (1024 * 1024)
    expect(mb).toBeGreaterThan(20 * 0.92)
    expect(mb).toBeLessThan(20 * 1.08)
    expect(result.rateControl).toBe('abr')
    expect(result.crf).toBeNull()
  })

  it('码率不足时自动降分辨率而不是静默失败', () => {
    const result = computeEstimate(
      makeEstimateInput({ targetSizeMB: 8, media: makeMedia({ durationSec: 60 }) })
    )
    expect(result.ok).toBe(true)
    expect(result.scaledResolution).toBe(true)
    expect(result.width).toBeLessThan(1920)
  })

  it('目标体积过小时给出最小可达体积', () => {
    const result = computeEstimate(
      makeEstimateInput({ targetSizeMB: 0.5, media: makeMedia({ durationSec: 60 }) })
    )
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TARGET_UNREACHABLE')
    expect(result.minimumSizeMB).toBeGreaterThan(0.5)
    expect(result.error?.hint).toContain('最小可达')
  })

  it('缺少时长时目标体积模式明确报错', () => {
    const result = computeEstimate(makeEstimateInput({ targetSizeMB: 10, media: makeMedia({ durationSec: null }) }))
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('DURATION_UNKNOWN')
  })
})

describe('分辨率选择', () => {
  it('码率充足时保持源分辨率，不做无意义重采样', () => {
    const decision = selectResolution({ sourceWidth: 1920, sourceHeight: 1080, frameRate: 30, videoBitrateKbps: 8000, codec: 'h264' })
    expect(decision.changed).toBe(false)
    expect(decision.width).toBe(1920)
    expect(decision.height).toBe(1080)
  })

  it('码率不足时逐级下降，且不低于 360 短边', () => {
    const decision = selectResolution({ sourceWidth: 1920, sourceHeight: 1080, frameRate: 30, videoBitrateKbps: 400, codec: 'h264' })
    expect(decision.changed).toBe(true)
    expect(Math.min(decision.width, decision.height)).toBeGreaterThanOrEqual(360)
    expect(decision.height).toBeLessThan(1080)
  })

  it('竖屏按短边取档，不会降到 360×640 以下', () => {
    const decision = selectResolution({ sourceWidth: 1080, sourceHeight: 1920, frameRate: 30, videoBitrateKbps: 200, codec: 'h264' })
    expect(decision.width).toBeLessThan(decision.height)
    expect(Math.min(decision.width, decision.height)).toBeGreaterThanOrEqual(360)
  })

  it('绝不升采样：低分辨率源的估算不高于源', () => {
    const result = computeEstimate(makeEstimateInput({ media: makeMedia({ width: 640, height: 360 }), quality: 100 }))
    expect(result.width).toBeLessThanOrEqual(640)
    expect(result.height).toBeLessThanOrEqual(360)
  })

  it('候选档位与源差距不足 10% 时保持源尺寸', () => {
    const decision = selectResolution({ sourceWidth: 4032, sourceHeight: 2268, frameRate: 30, videoBitrateKbps: 20000, codec: 'h264' })
    expect(decision.changed).toBe(false)
    expect(decision.width).toBe(4032)
  })

  it('requiredBitrateBps 与编码器 minBpp 一致', () => {
    // h264 minBpp = 0.05 → 1920*1080*30*0.05 = 3_110_400
    expect(requiredBitrateBps(1920, 1080, 30, 'h264')).toBe(3_110_400)
  })
})

describe('帧率选择', () => {
  it('源帧率 ≤60 且码率充足时保持源帧率', () => {
    const result = computeEstimate(makeEstimateInput({ media: makeMedia({ frameRate: 30 }) }))
    expect(result.frameRate).toBe(30)
    expect(result.changedFrameRate).toBe(false)
  })

  it('高帧率源按 60fps 封顶', () => {
    const result = computeEstimate(makeEstimateInput({ media: makeMedia({ frameRate: 120 }), quality: 80 }))
    expect(result.frameRate).toBe(60)
    expect(result.changedFrameRate).toBe(true)
  })

  it('高帧率 + 极低质量档位时进一步降到 30fps', () => {
    const result = computeEstimate(makeEstimateInput({ media: makeMedia({ frameRate: 120 }), quality: 0 }))
    expect(result.frameRate).toBe(30)
  })

  it('25fps 源不会被强行改成 30fps', () => {
    const result = computeEstimate(makeEstimateInput({ media: makeMedia({ frameRate: 25 }) }))
    expect(result.frameRate).toBeCloseTo(25, 5)
  })
})

describe('音频规则', () => {
  it('源音频码率低于目标时不放大，并对齐到 8k', () => {
    const result = computeEstimate(makeEstimateInput({ media: makeMedia({ audioBitRate: 64_000 }) }))
    expect(result.audioBitrateKbps).toBe(64)
  })

  it('5.1 声道降为立体声并在说明中提示', () => {
    const result = computeEstimate(makeEstimateInput({ media: makeMedia({ audioChannels: 6 }) }))
    expect(result.audioChannels).toBe(2)
    expect(result.explanations.some((text) => text.includes('立体声'))).toBe(true)
  })

  it('96kHz 源重采样到 48kHz', () => {
    const result = computeEstimate(makeEstimateInput({ media: makeMedia({ audioSampleRate: 96_000 }) }))
    expect(result.audioSampleRate).toBe(48_000)
  })

  it('无音轨时音频码率为 0 且给出提示', () => {
    const result = computeEstimate(makeEstimateInput({ media: makeMedia({ hasAudio: false }) }))
    expect(result.audioBitrateKbps).toBe(0)
    expect(result.explanations.some((text) => text.includes('没有音轨'))).toBe(true)
  })

  it('复制音轨模式沿用源码率', () => {
    const result = computeEstimate(makeEstimateInput({ audioMode: 'copy', media: makeMedia({ audioBitRate: 192_000 }) }))
    expect(result.audioBitrateKbps).toBe(192)
  })

  it('移除音轨模式音频码率为 0', () => {
    const result = computeEstimate(makeEstimateInput({ audioMode: 'none' }))
    expect(result.audioBitrateKbps).toBe(0)
  })
})

describe('异常输入', () => {
  it('没有视频流时给出明确错误', () => {
    const result = computeEstimate(makeEstimateInput({ media: makeMedia({ hasVideo: false }) }))
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('NO_VIDEO_STREAM')
  })

  it('HDR 源给出偏色警告', () => {
    const result = computeEstimate(makeEstimateInput({ media: makeMedia({ hdr: true }) }))
    expect(result.explanations.some((text) => text.includes('HDR'))).toBe(true)
  })

  it('估算说明非空且包含关键推导', () => {
    const result = computeEstimate(makeEstimateInput())
    expect(result.explanations.length).toBeGreaterThan(3)
    expect(result.explanations.some((text) => text.includes('CRF'))).toBe(true)
    expect(result.explanations.some((text) => text.includes('预计体积'))).toBe(true)
  })
})
