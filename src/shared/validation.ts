/**
 * 参数校验：Zod 结构校验 + 跨字段兼容性校验（PLAN §5.8）。
 *
 * 纯函数，返回面向用户的中文错误与修正建议；渲染层与主进程共用同一套规则。
 */
import { z } from 'zod'
import {
  AUDIO_CODEC_LABELS,
  AUDIO_STREAM_CODEC,
  CODEC_PROFILES,
  CONTAINER_INFO,
  VIDEO_CODEC_LABELS,
  codecForEncoder,
  isAudioCodecSupported,
  isVideoCodecSupported
} from './presets'
import type { JobSpec, ValidationIssue, ValidationResult } from './types'

export const MIN_DIMENSION = 16
export const MAX_DIMENSION = 8192
export const MIN_VIDEO_BITRATE_KBPS = 50
export const MAX_VIDEO_BITRATE_KBPS = 80000
export const MIN_FRAME_RATE = 1
export const MAX_FRAME_RATE = 120

const evenDimension = z
  .number()
  .int('必须是整数')
  .min(MIN_DIMENSION, `不能小于 ${MIN_DIMENSION}`)
  .max(MAX_DIMENSION, `不能大于 ${MAX_DIMENSION}`)
  .refine((value) => value % 2 === 0, '必须为偶数（编码器要求）')

export const containerSchema = z.enum(['mp4', 'mkv', 'webm', 'mov'])
export const videoCodecSchema = z.enum(['h264', 'hevc', 'av1', 'vp9'])
export const audioCodecSchema = z.enum(['aac', 'opus', 'mp3', 'flac'])

export const videoOptionsSchema = z.object({
  codec: videoCodecSchema,
  encoder: z.string().min(1).max(64).nullable(),
  rateControl: z.enum(['crf', 'abr', 'pass2']),
  crf: z.number().int('必须是整数').min(0).max(63).nullable(),
  bitrateKbps: z
    .number()
    .min(MIN_VIDEO_BITRATE_KBPS, `不能低于 ${MIN_VIDEO_BITRATE_KBPS} kbps`)
    .max(MAX_VIDEO_BITRATE_KBPS, `不能高于 ${MAX_VIDEO_BITRATE_KBPS} kbps`)
    .nullable(),
  width: evenDimension.nullable(),
  height: evenDimension.nullable(),
  frameRate: z.number().min(MIN_FRAME_RATE).max(MAX_FRAME_RATE).nullable(),
  preset: z.string().max(32).nullable(),
  profile: z.string().max(32).nullable(),
  level: z.string().max(16).nullable(),
  pixelFormat: z.string().max(32).nullable(),
  gop: z.number().int().min(1).max(600).nullable(),
  bframes: z.number().int().min(0).max(16).nullable(),
  hwAccel: z.boolean()
})

export const audioOptionsSchema = z.object({
  mode: z.enum(['encode', 'copy', 'none']),
  codec: audioCodecSchema,
  bitrateKbps: z.number().min(32).max(512).nullable(),
  channels: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  sampleRate: z.number().int().min(8000).max(192000).nullable()
})

export const outputOptionsSchema = z.object({
  directory: z.string().max(1024).nullable(),
  nameTemplate: z.string().min(1).max(200),
  conflict: z.enum(['ask', 'rename', 'overwrite', 'skip']),
  keepMetadata: z.boolean(),
  keepChapters: z.boolean()
})

export const jobSpecSchema = z.object({
  inputPath: z.string().min(1).max(1024),
  container: containerSchema,
  video: videoOptionsSchema,
  audio: audioOptionsSchema,
  output: outputOptionsSchema,
  extraArgs: z.array(z.string().max(200)).max(64)
})

/** 附加参数中禁止出现的选项（会破坏我们构造的参数结构）。 */
const FORBIDDEN_ARGS = new Set([
  '-i',
  '-f',
  '-y',
  '-n',
  '-progress',
  '-map',
  '-map_metadata',
  '-map_chapters',
  '-pass',
  '-passlogfile',
  '-ss',
  '-to',
  '-t',
  '-shortest',
  '-filter_complex',
  '-lavfi',
  '-nostdin',
  '-hide_banner',
  '-c',
  '-c:v',
  '-c:a',
  '-vcodec',
  '-acodec',
  '-b:v',
  '-b:a',
  '-crf',
  '-vf',
  '-r',
  '-s',
  '-fps_mode'
])

/** 允许的附加参数前缀（不在此列表内的参数给出警告但不阻断）。 */
const ALLOWED_PREFIXES = [
  '-x264-params',
  '-x265-params',
  '-svtav1-params',
  '-aom-params',
  '-tune',
  '-threads',
  '-aq-mode',
  '-deblock',
  '-psy-rd',
  '-me',
  '-merange',
  '-subq',
  '-qcomp',
  '-g',
  '-keyint_min',
  '-sc_threshold',
  '-bf',
  '-refs',
  '-color_primaries',
  '-color_trc',
  '-colorspace',
  '-metadata'
]

const MEDIA_PATH_PATTERN = /\.(mp4|mkv|webm|mov|avi|flv|wmv|m4v|ts|mpg|mpeg)$/i

/** 把命令行字符串切成参数数组，支持单双引号包裹。 */
export function tokenizeArgs(raw: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (const char of raw) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current) tokens.push(current)
  return tokens
}

/** 校验用户填写的额外参数。 */
export function sanitizeExtraArgs(input: string | string[]): { args: string[]; issues: ValidationIssue[] } {
  const raw = Array.isArray(input) ? input : tokenizeArgs(input)
  const args: string[] = []
  const issues: ValidationIssue[] = []

  let expectValue = false
  for (const token of raw) {
    // 选项后的取值片段（例如 -x264-params ref=4 中的 ref=4）无需再次校验。
    if (expectValue && !token.startsWith('-')) {
      expectValue = false
      args.push(token)
      continue
    }
    const key = token.split('=')[0].toLowerCase()
    if (FORBIDDEN_ARGS.has(key)) {
      issues.push({
        field: 'extraArgs',
        code: 'FORBIDDEN_ARG',
        message: `附加参数中不能包含 ${key}`,
        hint: '该参数由 Shrinkly 统一管理，请改用界面上的对应选项。'
      })
      continue
    }
    if (MEDIA_PATH_PATTERN.test(token)) {
      issues.push({
        field: 'extraArgs',
        code: 'OUTPUT_PATH_ARG',
        message: `附加参数中不能包含文件名：${token}`,
        hint: '输入/输出路径由 Shrinkly 负责，请删掉该参数。'
      })
      continue
    }
    if (!token.startsWith('-')) {
      issues.push({
        field: 'extraArgs',
        code: 'SUSPICIOUS_ARG',
        message: `附加参数 ${token} 不是标准选项`,
        hint: '请确认拼写；参数值应与对应选项放在一起。'
      })
      args.push(token)
      continue
    }
    const allowed = ALLOWED_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix}:`))
    if (!allowed) {
      issues.push({
        field: 'extraArgs',
        code: 'SUSPICIOUS_ARG',
        message: `附加参数 ${key} 不在推荐白名单内`,
        hint: '仍会传给 ffmpeg，但可能导致转换失败，请自行确认。'
      })
    }
    expectValue = true
    args.push(token)
  }

  return { args, issues }
}

/** 校验命名模板中的 token。 */
const TEMPLATE_TOKENS = ['name', 'ext', 'codec', 'resolution', 'fps', 'q', 'date', 'time', 'index']

export function validateNameTemplate(template: string): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const matches = template.matchAll(/\{([^}]*)\}/g)
  const seen = new Set<string>()
  let explicitName = 0
  for (const match of matches) {
    const token = match[1].trim()
    if (token === 'name') explicitName += 1
    if (!TEMPLATE_TOKENS.includes(token)) {
      issues.push({
        field: 'output.nameTemplate',
        code: 'UNKNOWN_TEMPLATE_TOKEN',
        message: `未知的命名占位符 {${token}}`,
        hint: `可用占位符：${TEMPLATE_TOKENS.map((t) => `{${t}}`).join(' ')}`
      })
    }
    seen.add(token)
  }
  if (/\.\{[^}]*\}/.test(template) && !template.toLowerCase().includes('{ext}')) {
    issues.push({
      field: 'output.nameTemplate',
      code: 'TEMPLATE_EXT_LITERAL',
      message: '命名模板看起来手写了扩展名',
      hint: '建议使用 {ext} 占位符，避免扩展名与容器不一致。'
    })
  }
  if (explicitName === 0) {
    issues.push({
      field: 'output.nameTemplate',
      code: 'TEMPLATE_NO_NAME',
      message: '命名模板缺少 {name}，可能导致输出文件名重复',
      hint: '建议保留 {name} 以保证每个源文件得到独立名称。'
    })
  }
  return issues
}

function pushIssue(
  target: ValidationIssue[],
  field: string,
  code: string,
  message: string,
  hint: string
): void {
  target.push({ field, code, message, hint })
}

export interface ValidateContext {
  /** 源音频编码（copy 模式兼容性判定）。 */
  sourceAudioCodec?: string | null
  /** 源宽高（宽高比偏差提示）。 */
  sourceWidth?: number | null
  sourceHeight?: number | null
  /** 可用编码器 id 列表（能力探测结果）。 */
  availableEncoders?: string[] | null
  /** 输出文件名（用于扩展名校验）。 */
  outputFileName?: string | null
}

/** 校验完整任务参数，返回错误与提示。 */
export function validateJobSpec(spec: JobSpec, context: ValidateContext = {}): ValidationResult {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []

  const parsed = jobSpecSchema.safeParse(spec)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      pushIssue(
        errors,
        issue.path.join('.') || 'spec',
        'SCHEMA_INVALID',
        issue.message,
        '请检查该字段的取值。'
      )
    }
  }

  const { container, video, audio } = spec
  const containerInfo = CONTAINER_INFO[container]
  const profile = CODEC_PROFILES[video.codec]

  // 容器 × 视频编码
  if (!isVideoCodecSupported(container, video.codec)) {
    const alternatives = containerInfo.video.map((codec) => VIDEO_CODEC_LABELS[codec]).join(' / ')
    pushIssue(
      errors,
      'video.codec',
      'CONTAINER_VIDEO_INCOMPATIBLE',
      `${containerInfo.label} 容器不支持 ${VIDEO_CODEC_LABELS[video.codec]}`,
      `${containerInfo.label} 支持的视频编码：${alternatives}；如需该编码请改用 MKV。`
    )
  }

  // 容器 × 音频编码
  if (audio.mode === 'encode' && !isAudioCodecSupported(container, audio.codec)) {
    const alternatives = containerInfo.audio.map((codec) => AUDIO_CODEC_LABELS[codec]).join(' / ')
    pushIssue(
      errors,
      'audio.codec',
      'CONTAINER_AUDIO_INCOMPATIBLE',
      `${containerInfo.label} 容器不支持 ${AUDIO_CODEC_LABELS[audio.codec]} 音频`,
      `${containerInfo.label} 支持的音频编码：${alternatives}；如需该编码请改用 MKV。`
    )
  }

  // copy 模式：源音频编码必须能被容器容纳
  if (audio.mode === 'copy' && context.sourceAudioCodec) {
    const sourceCodec = context.sourceAudioCodec.toLowerCase()
    const supported = containerInfo.audio.some((codec) => AUDIO_STREAM_CODEC[codec] === sourceCodec)
    if (!supported) {
      pushIssue(
        errors,
        'audio.mode',
        'AUDIO_COPY_INCOMPATIBLE',
        `${containerInfo.label} 容器无法容纳源音轨（${sourceCodec}）`,
        '请改用「重编码」音频，或把容器换成 MKV。'
      )
    }
  }

  // WebM 特殊说明
  if (container === 'webm' && (video.codec === 'h264' || video.codec === 'hevc' || (audio.mode === 'encode' && audio.codec !== 'opus'))) {
    pushIssue(
      errors,
      'container',
      'WEBM_RESTRICTED',
      'WebM 仅支持 VP9 / AV1 + Opus',
      '请把容器改为 MKV 或 MP4，或把视频改为 VP9 / AV1、音频改为 Opus。'
    )
  }

  // 码率控制字段一致性
  if (video.rateControl === 'crf') {
    if (video.crf === null) {
      pushIssue(errors, 'video.crf', 'CRF_REQUIRED', 'CRF 模式下必须填写 CRF 数值', '建议使用 16–32 之间的取值。')
    } else if (video.crf < profile.crfRange.min || video.crf > profile.crfRange.max) {
      pushIssue(
        errors,
        'video.crf',
        'CRF_OUT_OF_RANGE',
        `${VIDEO_CODEC_LABELS[video.codec]} 的 CRF 范围为 ${profile.crfRange.min}–${profile.crfRange.max}，当前为 ${video.crf}`,
        '请调整到合法区间，数值越小画质越高。'
      )
    }
  } else {
    if (video.bitrateKbps === null) {
      pushIssue(
        errors,
        'video.bitrateKbps',
        'BITRATE_REQUIRED',
        `${video.rateControl === 'pass2' ? '两遍' : 'ABR'} 模式必须填写视频码率`,
        `请填写 ${MIN_VIDEO_BITRATE_KBPS}–${MAX_VIDEO_BITRATE_KBPS} kbps 之间的值。`
      )
    }
    if (video.crf !== null) {
      pushIssue(warnings, 'video.crf', 'CRF_IGNORED', 'ABR 模式下 CRF 数值会被忽略', '如需恒定画质请把码率控制改为 CRF。')
    }
  }

  // 分辨率
  if ((video.width === null) !== (video.height === null)) {
    pushIssue(errors, 'video.width', 'SIZE_PARTIAL', '宽和高必须同时填写', '留空表示保持源分辨率。')
  }
  if (video.width !== null && video.height !== null) {
    if (context.sourceWidth && context.sourceHeight) {
      const sourceRatio = context.sourceWidth / context.sourceHeight
      const targetRatio = video.width / video.height
      const deviation = Math.abs(targetRatio - sourceRatio) / sourceRatio
      if (deviation > 0.05) {
        pushIssue(
          warnings,
          'video.width',
          'ASPECT_DEVIATION',
          `目标宽高比与源相差 ${(deviation * 100).toFixed(1)}%，画面可能被拉伸`,
          `源为 ${context.sourceWidth}×${context.sourceHeight}，建议按同一比例设置。`
        )
      }
    }
    if (context.sourceWidth && video.width > context.sourceWidth * 1.05) {
      pushIssue(warnings, 'video.width', 'UPSCALING', '目标分辨率高于源分辨率，画质不会提升', '建议保持源分辨率或缩小。')
    }
  }

  // 帧率
  if (video.frameRate !== null) {
    if (video.frameRate > MAX_FRAME_RATE) {
      pushIssue(errors, 'video.frameRate', 'FPS_TOO_HIGH', `帧率不能高于 ${MAX_FRAME_RATE}`, '请降低帧率。')
    }
    if (context.sourceWidth && video.frameRate > 61) {
      pushIssue(warnings, 'video.frameRate', 'FPS_HIGH', '高于 60fps 的输出在多数播放器上收益有限', '建议 60fps 以下。')
    }
  }

  // 编码器可用性
  if (video.encoder) {
    if (context.availableEncoders && context.availableEncoders.length > 0 && !context.availableEncoders.includes(video.encoder)) {
      pushIssue(
        errors,
        'video.encoder',
        'ENCODER_MISSING',
        `当前 ffmpeg 不包含编码器 ${video.encoder}`,
        '请改用其他编码器，或在设置里更新 ffmpeg。'
      )
    }
    const encoderCodec = codecForEncoder(video.encoder)
    if (encoderCodec && encoderCodec !== video.codec) {
      pushIssue(
        errors,
        'video.encoder',
        'ENCODER_CODEC_MISMATCH',
        `编码器 ${video.encoder} 属于 ${VIDEO_CODEC_LABELS[encoderCodec]}，与所选编码 ${VIDEO_CODEC_LABELS[video.codec]} 不一致`,
        '请重新选择编码器。'
      )
    }
    if (!isVideoCodecSupported(container, codecForEncoder(video.encoder) ?? video.codec)) {
      pushIssue(errors, 'video.encoder', 'ENCODER_CONTAINER_INCOMPATIBLE', `${containerInfo.label} 容器不支持编码器 ${video.encoder}`, '请更换容器或编码器。')
    }
  }

  // 音频细节
  if (audio.mode === 'copy') {
    if (audio.bitrateKbps !== null || audio.channels !== 0 || audio.sampleRate !== null) {
      pushIssue(warnings, 'audio.mode', 'AUDIO_COPY_IGNORES_OPTIONS', '复制音轨时码率 / 声道 / 采样率设置会被忽略', '如需调整音频参数请改为「重编码」。')
    }
  } else if (audio.mode === 'encode') {
    if (audio.bitrateKbps === null) {
      pushIssue(warnings, 'audio.bitrateKbps', 'AUDIO_BITRATE_MISSING', '未填写音频码率，将按质量档位自动取值', '通常无需手动指定。')
    }
    if (audio.codec === 'flac' && audio.bitrateKbps !== null) {
      pushIssue(warnings, 'audio.bitrateKbps', 'FLAC_FIXED_BITRATE', 'FLAC 是无损编码，码率设置无效', '如需控制体积请改用 AAC / Opus。')
    }
  }

  // 输出扩展名
  const outputName = context.outputFileName
  if (outputName) {
    const extension = outputName.includes('.') ? outputName.split('.').pop()?.toLowerCase() : ''
    if (extension !== containerInfo.extension) {
      pushIssue(
        errors,
        'output.nameTemplate',
        'EXTENSION_MISMATCH',
        `输出文件名 ${outputName} 的扩展名与容器 ${containerInfo.label} 不一致`,
        `请把扩展名改为 .${containerInfo.extension}，或使用 {ext} 占位符。`
      )
    }
    if (/[<>:"/\\|?*]/.test(outputName)) {
      pushIssue(
        errors,
        'output.nameTemplate',
        'ILLEGAL_FILENAME',
        '输出文件名包含 Windows 不允许的字符（< > : " / \\ | ? *）',
        '请删除这些字符，或使用命名模板自动清理。'
      )
    }
  }

  // 额外参数
  const extraArgsResult = sanitizeExtraArgs(spec.extraArgs)
  for (const issue of extraArgsResult.issues) {
    if (issue.code === 'FORBIDDEN_ARG' || issue.code === 'OUTPUT_PATH_ARG') errors.push(issue)
    else warnings.push(issue)
  }

  // 命名模板
  for (const issue of validateNameTemplate(spec.output.nameTemplate)) {
    if (issue.code === 'UNKNOWN_TEMPLATE_TOKEN') errors.push(issue)
    else warnings.push(issue)
  }

  if (spec.output.conflict === 'ask') {
    pushIssue(warnings, 'output.conflict', 'CONFLICT_ASK', '冲突策略为「询问」，无人值守的批量任务会停在等待确认', '批量场景建议改为「自动重命名」。')
  }

  return { ok: errors.length === 0, errors, warnings }
}
