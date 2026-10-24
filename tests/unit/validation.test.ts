import { describe, expect, it } from 'vitest'
import { sanitizeExtraArgs, tokenizeArgs, validateJobSpec, validateNameTemplate } from '../../src/shared/validation'
import { makeSpec } from './fixtures'

function codes(field: 'errors' | 'warnings', spec = makeSpec(), context = {}) {
  return validateJobSpec(spec, context)[field].map((issue) => issue.code)
}

describe('JobSpec 基础校验', () => {
  it('默认参数合法', () => {
    const result = validateJobSpec(makeSpec())
    expect(result.ok).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('缺少输入路径时报错', () => {
    expect(codes('errors', makeSpec({ inputPath: '' }))).toContain('SCHEMA_INVALID')
  })

  it('码率超出上限时报错', () => {
    const spec = makeSpec({ video: { ...makeSpec().video, rateControl: 'abr', bitrateKbps: 90000, crf: null } })
    expect(codes('errors', spec)).toContain('SCHEMA_INVALID')
  })

  it('帧率高于 120 报错', () => {
    const spec = makeSpec({ video: { ...makeSpec().video, frameRate: 200 } })
    expect(codes('errors', spec)).toContain('SCHEMA_INVALID')
  })
})

describe('容器与编码兼容矩阵', () => {
  it('WebM 拒绝 H.264', () => {
    const spec = makeSpec({ container: 'webm', audio: { ...makeSpec().audio, codec: 'opus' } })
    const result = validateJobSpec(spec, {})
    expect(result.ok).toBe(false)
    expect(result.errors.map((e) => e.code)).toContain('CONTAINER_VIDEO_INCOMPATIBLE')
    expect(result.errors.some((e) => e.code === 'WEBM_RESTRICTED')).toBe(true)
  })

  it('WebM + VP9 + Opus 合法', () => {
    const spec = makeSpec({
      container: 'webm',
      video: { ...makeSpec().video, codec: 'vp9', encoder: 'libvpx-vp9', crf: 26, preset: null },
      audio: { ...makeSpec().audio, codec: 'opus', bitrateKbps: 96 }
    })
    expect(validateJobSpec(spec, {}).ok).toBe(true)
  })

  it('MP4 拒绝 Opus 音频', () => {
    const spec = makeSpec({ audio: { ...makeSpec().audio, codec: 'opus' } })
    expect(codes('errors', spec)).toContain('CONTAINER_AUDIO_INCOMPATIBLE')
  })

  it('MP4 拒绝 VP9 视频', () => {
    const spec = makeSpec({ video: { ...makeSpec().video, codec: 'vp9', encoder: 'libvpx-vp9', crf: 30 } })
    expect(codes('errors', spec)).toContain('CONTAINER_VIDEO_INCOMPATIBLE')
  })

  it('MKV 支持 VP9 + Opus', () => {
    const spec = makeSpec({
      container: 'mkv',
      video: { ...makeSpec().video, codec: 'vp9', encoder: 'libvpx-vp9', crf: 30 },
      audio: { ...makeSpec().audio, codec: 'opus' }
    })
    expect(validateJobSpec(spec, {}).ok).toBe(true)
  })

  it('复制音轨时校验源编码是否被容器容纳', () => {
    const spec = makeSpec({
      container: 'webm',
      video: { ...makeSpec().video, codec: 'vp9', encoder: 'libvpx-vp9', crf: 30 },
      audio: { ...makeSpec().audio, mode: 'copy', bitrateKbps: null }
    })
    expect(codes('errors', spec, { sourceAudioCodec: 'aac' })).toContain('AUDIO_COPY_INCOMPATIBLE')
    expect(validateJobSpec(spec, { sourceAudioCodec: 'opus' }).ok).toBe(true)
  })
})

describe('数值边界', () => {
  it('CRF 越界报错并说明合法区间', () => {
    const spec = makeSpec({ video: { ...makeSpec().video, crf: 60 } })
    const result = validateJobSpec(spec)
    const issue = result.errors.find((e) => e.code === 'CRF_OUT_OF_RANGE')
    expect(issue).toBeDefined()
    expect(issue?.message).toContain('0–51')
  })

  it('VP9 允许 CRF 60', () => {
    const spec = makeSpec({ container: 'mkv', video: { ...makeSpec().video, codec: 'vp9', encoder: 'libvpx-vp9', crf: 60 } })
    expect(validateJobSpec(spec).errors).toHaveLength(0)
  })

  it('奇数尺寸被拒绝', () => {
    const spec = makeSpec({ video: { ...makeSpec().video, width: 1921, height: 1080 } })
    expect(codes('errors', spec)).toContain('SCHEMA_INVALID')
  })

  it('尺寸小于 16 被拒绝', () => {
    const spec = makeSpec({ video: { ...makeSpec().video, width: 8, height: 8 } })
    expect(codes('errors', spec)).toContain('SCHEMA_INVALID')
  })

  it('只填宽不填高报错', () => {
    const spec = makeSpec({ video: { ...makeSpec().video, width: 1280, height: null } })
    expect(codes('errors', spec)).toContain('SIZE_PARTIAL')
  })

  it('ABR 模式缺码率报错', () => {
    const spec = makeSpec({ video: { ...makeSpec().video, rateControl: 'abr', crf: null, bitrateKbps: null } })
    expect(codes('errors', spec)).toContain('BITRATE_REQUIRED')
  })

  it('宽高比偏差过大给出警告', () => {
    const spec = makeSpec({ video: { ...makeSpec().video, width: 1280, height: 720 } })
    expect(codes('warnings', spec, { sourceWidth: 1080, sourceHeight: 1920 })).toContain('ASPECT_DEVIATION')
  })
})

describe('输出与命名', () => {
  it('扩展名与容器不一致时报错', () => {
    const spec = makeSpec({ container: 'webm', video: { ...makeSpec().video, codec: 'vp9', encoder: 'libvpx-vp9' }, audio: { ...makeSpec().audio, codec: 'opus' } })
    expect(codes('errors', spec, { outputFileName: 'demo.mp4' })).toContain('EXTENSION_MISMATCH')
  })

  it('文件名含非法字符时报错', () => {
    expect(codes('errors', makeSpec(), { outputFileName: 'a:b.mp4' })).toContain('ILLEGAL_FILENAME')
  })

  it('未知命名占位符报错', () => {
    expect(validateNameTemplate('{name}_{bogus}.{ext}').some((i) => i.code === 'UNKNOWN_TEMPLATE_TOKEN')).toBe(true)
  })

  it('缺少 {name} 给出警告', () => {
    expect(validateNameTemplate('compressed_{ext}').some((i) => i.code === 'TEMPLATE_NO_NAME')).toBe(true)
  })

  it('合法模板不产生问题', () => {
    expect(validateNameTemplate('{name}_compressed_{resolution}.{ext}')).toHaveLength(0)
  })
})

describe('额外参数白名单', () => {
  it('拒绝 -i 等结构性参数', () => {
    const { args, issues } = sanitizeExtraArgs(['-i', 'other.mp4'])
    expect(issues.map((i) => i.code)).toContain('FORBIDDEN_ARG')
    expect(issues.map((i) => i.code)).toContain('OUTPUT_PATH_ARG')
    expect(args).toHaveLength(0)
  })

  it('拒绝输出文件路径片段', () => {
    const { issues } = sanitizeExtraArgs('output.mp4')
    expect(issues.map((i) => i.code)).toContain('OUTPUT_PATH_ARG')
  })

  it('白名单参数被接受且不产生问题', () => {
    const { args, issues } = sanitizeExtraArgs('-x264-params ref=4 -tune film')
    expect(args).toEqual(['-x264-params', 'ref=4', '-tune', 'film'])
    expect(issues).toHaveLength(0)
  })

  it('未知参数给出可疑警告但仍传递', () => {
    const { args, issues } = sanitizeExtraArgs('-weird-flag 1')
    expect(args).toContain('-weird-flag')
    expect(issues.map((i) => i.code)).toContain('SUSPICIOUS_ARG')
  })

  it('tokenizeArgs 支持引号包裹', () => {
    expect(tokenizeArgs('-metadata title="hello world"')).toEqual(['-metadata', 'title=hello world'])
  })
})

describe('编码器校验', () => {
  it('编码器与编码族不匹配时报错', () => {
    const spec = makeSpec({ video: { ...makeSpec().video, codec: 'hevc', encoder: 'libx264' } })
    expect(codes('errors', spec)).toContain('ENCODER_CODEC_MISMATCH')
  })

  it('编码器不存在时报错', () => {
    const spec = makeSpec({ video: { ...makeSpec().video, encoder: 'h264_nvenc' } })
    expect(codes('errors', spec, { availableEncoders: ['libx264', 'libx265'] })).toContain('ENCODER_MISSING')
  })
})
