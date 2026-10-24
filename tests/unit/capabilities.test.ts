import { describe, expect, it } from 'vitest'
import {
  buildEncoderCapabilities,
  parseEncoderList,
  parseHwaccelList,
  pickHardwareEncoder
} from '../../src/server/ffmpeg/capabilities'
import { parseVersion } from '../../src/server/ffmpeg/locator'

const ENCODERS_OUTPUT = `Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D libx264              libx264 H.264 / AVC (codec h264)
 V....D libx265              libx265 H.265 / HEVC (codec hevc)
 V....D libvpx-vp9           libvpx VP9 (codec vp9)
 V....D libaom-av1           libaom AV1 (codec av1)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V....D hevc_qsv             HEVC (Intel Quick Sync Video) (codec hevc)
 A....D aac                  AAC encoder
 A....D libopus              libopus Opus
 S..... srt                  SubRip subtitle
`

const HWACCELS_OUTPUT = `Hardware acceleration methods:
cuda
dxva2
qsv
d3d11va
opencl
vulkan
`

describe('parseEncoderList', () => {
  it('按类型拆分编码器', () => {
    const parsed = parseEncoderList(ENCODERS_OUTPUT)
    expect(parsed.video).toContain('libx264')
    expect(parsed.video).toContain('h264_nvenc')
    expect(parsed.audio).toEqual(['aac', 'libopus'])
    expect(parsed.subtitle).toEqual(['srt'])
  })

  it('忽略表头与说明行', () => {
    const parsed = parseEncoderList(ENCODERS_OUTPUT)
    expect(parsed.video).not.toContain('=')
    expect(parsed.video).toHaveLength(6)
  })

  it('空输出返回空数组', () => {
    expect(parseEncoderList('')).toEqual({ video: [], audio: [], subtitle: [] })
  })
})

describe('parseHwaccelList', () => {
  it('去掉标题行', () => {
    expect(parseHwaccelList(HWACCELS_OUTPUT)).toEqual(['cuda', 'dxva2', 'qsv', 'd3d11va', 'opencl', 'vulkan'])
  })
})

describe('buildEncoderCapabilities', () => {
  it('标记软件与硬件编码器可用性', () => {
    const list = buildEncoderCapabilities(['libx264', 'libx265', 'libvpx-vp9', 'libaom-av1', 'h264_nvenc', 'hevc_qsv'], ['cuda', 'qsv'])
    const nvenc = list.find((e) => e.id === 'h264_nvenc')
    const qsv = list.find((e) => e.id === 'hevc_qsv')
    const amf = list.find((e) => e.id === 'h264_amf')
    expect(nvenc?.available).toBe(true)
    expect(qsv?.available).toBe(true)
    expect(amf?.available).toBe(false)
    expect(list.filter((e) => e.kind === 'software').every((e) => e.available)).toBe(true)
  })

  it('按 nvenc → qsv → amf 优先级选择硬件编码器', () => {
    const list = buildEncoderCapabilities(['h264_nvenc', 'h264_qsv', 'h264_amf'], ['cuda', 'qsv'])
    const capabilities = {
      version: null,
      encoders: ['h264_nvenc', 'h264_qsv', 'h264_amf'],
      videoEncoders: list,
      hwaccels: ['cuda', 'qsv'] as never,
      audioEncoders: [],
      probedAt: 0
    }
    expect(pickHardwareEncoder(capabilities, 'h264')).toBe('h264_nvenc')
  })

  it('没有可用硬件编码器时返回 null', () => {
    const list = buildEncoderCapabilities(['libx264'], [])
    const capabilities = {
      version: null,
      encoders: ['libx264'],
      videoEncoders: list,
      hwaccels: [] as never,
      audioEncoders: [],
      probedAt: 0
    }
    expect(pickHardwareEncoder(capabilities, 'h264')).toBeNull()
  })
})

describe('parseVersion', () => {
  it('从 -version 输出提取版本号', () => {
    const stdout = 'ffmpeg version 2026-07-02-git-95a888b9ca-essentials_build-www.gyan.dev Copyright (c) 2000-2026'
    expect(parseVersion(stdout)).toBe('2026-07-02-git-95a888b9ca-essentials_build-www.gyan.dev')
  })

  it('无版本信息时返回 null', () => {
    expect(parseVersion('nothing here')).toBeNull()
  })
})
