import { describe, expect, it } from 'vitest'
import { parseFrameRate, parseProbeJson } from '../../src/server/ffmpeg/probe'
import type { FfprobeJson } from '../../src/server/ffmpeg/probe'

const baseJson: FfprobeJson = {
  streams: [
    {
      index: 0,
      codec_name: 'h264',
      codec_long_name: 'H.264 / AVC',
      codec_type: 'video',
      width: 1920,
      height: 1080,
      avg_frame_rate: '30000/1001',
      r_frame_rate: '30000/1001',
      bit_rate: '4500000',
      pix_fmt: 'yuv420p',
      color_space: 'bt709',
      color_transfer: 'bt709',
      color_primaries: 'bt709',
      field_order: 'progressive',
      sample_aspect_ratio: '1:1',
      display_aspect_ratio: '16:9'
    },
    {
      index: 1,
      codec_name: 'aac',
      codec_type: 'audio',
      bit_rate: '128000',
      channels: 2,
      sample_rate: '48000',
      tags: { language: 'und' }
    }
  ],
  format: {
    duration: '12.512000',
    size: '7936000',
    bit_rate: '5072000',
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    format_long_name: 'QuickTime / MOV'
  },
  chapters: []
}

describe('parseFrameRate', () => {
  it('解析 NTSC 分数帧率', () => {
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2)
  })

  it('解析整数帧率', () => {
    expect(parseFrameRate('25/1')).toBe(25)
  })

  it('0/0 与空值视为未知', () => {
    expect(parseFrameRate('0/0')).toBe(0)
    expect(parseFrameRate(undefined)).toBe(0)
  })

  it('非法字符串不抛异常', () => {
    expect(parseFrameRate('abc')).toBe(0)
    expect(parseFrameRate('30/0')).toBe(0)
  })
})

describe('parseProbeJson', () => {
  it('解析基础字段', () => {
    const media = parseProbeJson(baseJson, 'D:/videos/样片 sample.mp4', 123)
    expect(media.fileName).toBe('样片 sample.mp4')
    expect(media.container).toBe('mov,mp4,m4a,3gp,3g2,mj2')
    expect(media.durationSec).toBeCloseTo(12.512, 3)
    expect(media.sizeBytes).toBe(7936000)
    expect(media.video?.width).toBe(1920)
    expect(media.video?.height).toBe(1080)
    expect(media.video?.frameRate).toBeCloseTo(29.97, 2)
    expect(media.audio?.channels).toBe(2)
    expect(media.audio?.sampleRate).toBe(48000)
    expect(media.audio?.bitRate).toBe(128000)
  })

  it('跳过封面图（attached_pic）流', () => {
    const withCover: FfprobeJson = {
      ...baseJson,
      streams: [
        { index: 0, codec_name: 'mjpeg', codec_type: 'video', width: 600, height: 600, disposition: { attached_pic: 1 } },
        ...(baseJson.streams ?? []),
        { index: 3, codec_name: 'png', codec_type: 'video', width: 300, height: 300, disposition: { attached_pic: 1 } }
      ]
    }
    const media = parseProbeJson(withCover, 'D:/videos/cover.mkv', 0)
    expect(media.video?.width).toBe(1920)
    expect(media.videoStreamCount).toBe(1)
    expect(media.warnings.some((w) => w.includes('封面图'))).toBe(true)
  })

  it('多音轨时保留第一路并提示', () => {
    const multi: FfprobeJson = {
      ...baseJson,
      streams: [
        ...(baseJson.streams ?? []),
        { index: 2, codec_name: 'aac', codec_type: 'audio', bit_rate: '192000', channels: 2, sample_rate: '48000' }
      ]
    }
    const media = parseProbeJson(multi, 'D:/videos/multi.mkv', 0)
    expect(media.audioStreamCount).toBe(2)
    expect(media.audio?.bitRate).toBe(128000)
    expect(media.warnings.some((w) => w.includes('2 路音轨'))).toBe(true)
  })

  it('时长缺失时用视频流时长兜底', () => {
    const noFormatDuration: FfprobeJson = {
      ...baseJson,
      format: { ...baseJson.format, duration: undefined },
      streams: [{ ...baseJson.streams![0], duration: '8.5' }, baseJson.streams![1]]
    }
    expect(parseProbeJson(noFormatDuration, 'a.mp4', 0).durationSec).toBeCloseTo(8.5, 3)
  })

  it('时长全缺失时用帧数 / 帧率估算', () => {
    const noDuration: FfprobeJson = {
      ...baseJson,
      format: { ...baseJson.format, duration: undefined },
      streams: [{ ...baseJson.streams![0], duration: undefined, avg_frame_rate: '25/1', nb_frames: '250' }, baseJson.streams![1]]
    }
    expect(parseProbeJson(noDuration, 'a.mp4', 0).durationSec).toBeCloseTo(10, 3)
  })

  it('完全无时长时给出警告', () => {
    const noDuration: FfprobeJson = {
      format: {},
      streams: [{ index: 0, codec_name: 'h264', codec_type: 'video', width: 640, height: 360 }]
    }
    const media = parseProbeJson(noDuration, 'a.mp4', 0)
    expect(media.durationSec).toBeNull()
    expect(media.warnings.some((w) => w.includes('无法读取时长'))).toBe(true)
  })

  it('音频码率缺失时用总码率减视频码率估算', () => {
    const partial: FfprobeJson = {
      ...baseJson,
      streams: [baseJson.streams![0], { ...baseJson.streams![1], bit_rate: undefined }],
      format: { ...baseJson.format, bit_rate: '4628000' }
    }
    expect(parseProbeJson(partial, 'a.mp4', 0).audio?.bitRate).toBe(128000)
  })

  it('检测 HDR 传递特性', () => {
    const hdr: FfprobeJson = {
      ...baseJson,
      streams: [{ ...baseJson.streams![0], color_transfer: 'smpte2084', color_primaries: 'bt2020' }, baseJson.streams![1]]
    }
    const media = parseProbeJson(hdr, 'hdr.mp4', 0)
    expect(media.video?.hdr).toBe(true)
    expect(media.warnings.some((w) => w.includes('HDR'))).toBe(true)
  })

  it('检测隔行扫描', () => {
    const interlaced: FfprobeJson = {
      ...baseJson,
      streams: [{ ...baseJson.streams![0], field_order: 'tt' }, baseJson.streams![1]]
    }
    expect(parseProbeJson(interlaced, 'a.mp4', 0).video?.interlaced).toBe(true)
  })

  it('无音轨时给出提示而不报错', () => {
    const silent: FfprobeJson = { ...baseJson, streams: [baseJson.streams![0]] }
    const media = parseProbeJson(silent, 'silent.mp4', 0)
    expect(media.audio).toBeNull()
    expect(media.warnings.some((w) => w.includes('未检测到音轨'))).toBe(true)
  })

  it('空 JSON 不会崩溃', () => {
    const media = parseProbeJson({}, 'empty.mp4', 42)
    expect(media.video).toBeNull()
    expect(media.sizeBytes).toBe(42)
    expect(media.warnings.length).toBeGreaterThan(0)
  })
})
