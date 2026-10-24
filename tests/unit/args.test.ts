import { describe, expect, it } from 'vitest'
import { buildFfmpegArgs, formatCommandForDisplay } from '../../src/main/ffmpeg/args'
import type { JobSpec } from '../../src/shared/types'
import { makeSpec } from './fixtures'

const INPUT = 'D:/videos/样片 sample.mp4'
const OUTPUT = 'D:/videos/样片 sample.part.mp4'

function build(spec: JobSpec, extra: Partial<Parameters<typeof buildFfmpegArgs>[0]> = {}) {
  return buildFfmpegArgs({ spec, input: INPUT, output: OUTPUT, ...extra })
}

function pairValue(args: string[], key: string): string | undefined {
  const index = args.indexOf(key)
  return index >= 0 ? args[index + 1] : undefined
}

describe('基础参数结构', () => {
  it('始终以隐藏横幅 + 输入路径开头，且不做 shell 拼接', () => {
    const args = build(makeSpec())
    expect(args.slice(0, 6)).toEqual(['-hide_banner', '-nostdin', '-y', '-i', INPUT, '-map'])
    expect(args[args.length - 1]).toBe(OUTPUT)
  })

  it('中文与空格路径原样传入（不被转义）', () => {
    const args = build(makeSpec())
    expect(args).toContain(INPUT)
    expect(args.join(' ')).toContain('样片 sample.mp4')
  })

  it('映射视频流与可选音轨，并保留元数据', () => {
    const args = build(makeSpec())
    expect(args).toContain('0:v:0')
    expect(args).toContain('0:a?')
    expect(pairValue(args, '-map_metadata')).toBe('0')
    expect(pairValue(args, '-map_chapters')).toBe('0')
  })

  it('包含 -progress pipe:1 供 runner 解析', () => {
    const args = build(makeSpec())
    expect(args).toContain('-progress')
    expect(args).toContain('pipe:1')
    expect(args).toContain('-nostats')
  })

  it('includeProgress=false 时不加进度参数（用于纯预览）', () => {
    const args = build(makeSpec(), { includeProgress: false })
    expect(args).not.toContain('-progress')
  })
})

describe('视频参数', () => {
  it('CRF 模式使用 -crf 与软件预设', () => {
    const args = build(makeSpec())
    expect(pairValue(args, '-c:v')).toBe('libx264')
    expect(pairValue(args, '-crf')).toBe('24')
    expect(pairValue(args, '-preset')).toBe('medium')
  })

  it('ABR 模式输出目标码率 / maxrate / bufsize', () => {
    const spec = makeSpec({ video: { ...makeSpec().video, rateControl: 'abr', crf: null, bitrateKbps: 2500 } })
    const args = build(spec)
    expect(pairValue(args, '-b:v')).toBe('2500k')
    expect(pairValue(args, '-maxrate')).toBe('3750k')
    expect(pairValue(args, '-bufsize')).toBe('5000k')
    expect(args).not.toContain('-crf')
  })

  it('两遍编码第一遍输出到 null 设备且不带音频参数', () => {
    const spec = makeSpec({ video: { ...makeSpec().video, rateControl: 'pass2', crf: null, bitrateKbps: 2000 } })
    const args = build(spec, { pass: 1 })
    expect(pairValue(args, '-pass')).toBe('1')
    expect(args).toContain('-f')
    expect(args[args.length - 1]).toMatch(/NUL|\/dev\/null/)
    expect(args).not.toContain('-c:a')
  })

  it('指定宽高时生成 scale 滤镜', () => {
    const spec = makeSpec({ video: { ...makeSpec().video, width: 1280, height: 720 } })
    expect(pairValue(build(spec), '-vf')).toBe('scale=1280:720:flags=lanczos')
  })

  it('指定帧率时使用 -r 与 -fps_mode cfr', () => {
    const spec = makeSpec({ video: { ...makeSpec().video, frameRate: 30 } })
    const args = build(spec)
    expect(pairValue(args, '-r')).toBe('30')
    expect(pairValue(args, '-fps_mode')).toBe('cfr')
  })

  it('不指定帧率时不加 -r（避免无谓重采样）', () => {
    expect(build(makeSpec())).not.toContain('-r')
  })

  it('硬件编码使用 VBR + CQ，并保留码率上限', () => {
    const spec = makeSpec({ video: { ...makeSpec().video, encoder: 'h264_nvenc', hwAccel: true } })
    const args = build(spec, { bitrateCapKbps: 6000 })
    expect(pairValue(args, '-c:v')).toBe('h264_nvenc')
    expect(pairValue(args, '-rc')).toBe('vbr')
    expect(pairValue(args, '-cq')).toBe('24')
    expect(pairValue(args, '-b:v')).toBe('6000k')
    expect(pairValue(args, '-preset')).toBe('p5')
  })

  it('VP9 软件编码带 row-mt 与 cpu-used', () => {
    const spec = makeSpec({
      container: 'mkv',
      video: { ...makeSpec().video, codec: 'vp9', encoder: 'libvpx-vp9', crf: 30, preset: null },
      audio: { ...makeSpec().audio, codec: 'opus' }
    })
    const args = build(spec)
    expect(pairValue(args, '-row-mt')).toBe('1')
    expect(pairValue(args, '-cpu-used')).toBe('2')
    expect(pairValue(args, '-b:v')).toBe('0')
  })
})

describe('音频参数', () => {
  it('重编码时给出编码器 / 码率 / 声道 / 采样率', () => {
    const spec = makeSpec({ audio: { ...makeSpec().audio, channels: 2, sampleRate: 48000 } })
    const args = build(spec)
    expect(pairValue(args, '-c:a')).toBe('aac')
    expect(pairValue(args, '-b:a')).toBe('160k')
    expect(pairValue(args, '-ac')).toBe('2')
    expect(pairValue(args, '-ar')).toBe('48000')
  })

  it('复制音轨时不得携带 -b:a / -ac / -ar', () => {
    const spec = makeSpec({ audio: { ...makeSpec().audio, mode: 'copy', bitrateKbps: null, sampleRate: null } })
    const args = build(spec)
    expect(pairValue(args, '-c:a')).toBe('copy')
    expect(args).not.toContain('-b:a')
    expect(args).not.toContain('-ac')
    expect(args).not.toContain('-ar')
  })

  it('移除音轨时使用 -an 且不映射音轨', () => {
    const spec = makeSpec({ audio: { ...makeSpec().audio, mode: 'none' } })
    const args = build(spec)
    expect(args).toContain('-an')
    expect(args).not.toContain('0:a?')
    expect(args).not.toContain('-c:a')
  })

  it('FLAC 不写码率参数', () => {
    const spec = makeSpec({ container: 'mkv', audio: { ...makeSpec().audio, codec: 'flac', bitrateKbps: null } })
    const args = build(spec)
    expect(pairValue(args, '-c:a')).toBe('flac')
    expect(args).not.toContain('-b:a')
  })
})

describe('容器参数', () => {
  it('MP4 加 faststart，HEVC 加 hvc1 标签', () => {
    const spec = makeSpec({ video: { ...makeSpec().video, codec: 'hevc', encoder: 'libx265', crf: 23 } })
    const args = build(spec)
    expect(pairValue(args, '-movflags')).toBe('+faststart')
    expect(pairValue(args, '-tag:v')).toBe('hvc1')
    expect(pairValue(args, '-f')).toBe('mp4')
  })

  it('WebM 使用 webm muxer 且不加 faststart', () => {
    const spec = makeSpec({
      container: 'webm',
      video: { ...makeSpec().video, codec: 'vp9', encoder: 'libvpx-vp9', crf: 30 },
      audio: { ...makeSpec().audio, codec: 'opus' }
    })
    const args = build(spec)
    expect(pairValue(args, '-f')).toBe('webm')
    expect(args).not.toContain('-movflags')
  })

  it('MKV 使用 matroska muxer', () => {
    const spec = makeSpec({ container: 'mkv' })
    expect(pairValue(build(spec), '-f')).toBe('matroska')
  })

  it('额外参数插入在输出路径之前', () => {
    const spec = makeSpec({ extraArgs: ['-x264-params', 'ref=4'] })
    const args = build(spec)
    const paramsIndex = args.indexOf('-x264-params')
    expect(paramsIndex).toBeGreaterThan(0)
    expect(paramsIndex).toBeLessThan(args.length - 1)
  })
})

describe('命令展示', () => {
  it('含空格的参数会被引号包裹', () => {
    const command = formatCommandForDisplay(['-i', 'D:/videos/样片 sample.mp4', '-crf', '24'])
    expect(command).toContain('"D:/videos/样片 sample.mp4"')
    expect(command).toContain('-crf 24')
  })
})
