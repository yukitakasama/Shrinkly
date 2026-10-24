/**
 * 错误分类：把底层异常 / ffmpeg stderr 转换成结构化的中文错误对象。
 *
 * 渲染层只负责展示 `{ code, title, detail, hint, raw }`，不做任何判断，
 * 便于后续国际化与复用。
 */
import type { JobError } from '../../shared/types'

export interface AppErrorInit {
  code: string
  title: string
  detail: string
  hint: string
  raw?: string
}

/** 带结构化信息的应用错误。 */
export class AppError extends Error {
  readonly code: string
  readonly title: string
  readonly detail: string
  readonly hint: string
  readonly raw: string | undefined

  constructor(init: AppErrorInit) {
    super(init.detail)
    this.name = 'AppError'
    this.code = init.code
    this.title = init.title
    this.detail = init.detail
    this.hint = init.hint
    this.raw = init.raw
  }

  toJobError(): JobError {
    const error: JobError = {
      code: this.code,
      title: this.title,
      detail: this.detail,
      hint: this.hint
    }
    if (this.raw) error.raw = this.raw
    return error
  }
}

/** 未知异常 → 结构化错误。 */
export function asJobError(error: unknown): JobError {
  if (error instanceof AppError) return error.toJobError()
  if (error instanceof Error) {
    return {
      code: 'UNEXPECTED',
      title: '发生未预期的错误',
      detail: error.message,
      hint: '请重试；若持续出现请查看日志文件并反馈。'
    }
  }
  return {
    code: 'UNEXPECTED',
    title: '发生未预期的错误',
    detail: String(error),
    hint: '请重试；若持续出现请查看日志文件并反馈。'
  }
}

interface PatternRule {
  test: RegExp
  code: string
  title: string
  detail: string
  hint: string
}

/** stderr 摘要 → 错误分类规则，按顺序匹配，命中即返回。 */
const STDERR_RULES: PatternRule[] = [
  {
    test: /(No space left on device|There is not enough space)/i,
    code: 'DISK_FULL',
    title: '磁盘空间不足',
    detail: '写入输出文件时磁盘已满。',
    hint: '请清理目标磁盘空间，或把输出目录改到空间充足的分区。'
  },
  {
    test: /(Permission denied|Access is denied|error opening for writing)/i,
    code: 'OUTPUT_NOT_WRITABLE',
    title: '输出位置不可写',
    detail: '目标文件或目录没有写入权限。',
    hint: '请换一个当前用户可写的输出目录，或关闭正在占用该文件的程序。'
  },
  {
    test: /(No such file or directory|The system cannot find the file|Invalid argument.*-i)/i,
    code: 'INPUT_NOT_FOUND',
    title: '找不到输入文件',
    detail: 'ffmpeg 无法打开输入文件。',
    hint: '请确认文件仍然存在、路径正确，且没有被其他程序独占。'
  },
  {
    test: /(Cannot load|No NVENC capable devices|No capable devices|InitializeEncoder failed|Failed to initialise|OpenEncodeSessionEx failed|device.*not.*(found|available)|No NVENC capable devices)/i,
    code: 'HW_ENCODER_UNAVAILABLE',
    title: '硬件编码不可用',
    detail: '硬件编码器初始化失败，可能显卡驱动不支持或设备被占用。',
    hint: 'Shrinkly 会自动回退到软件编码重试一次；也可以在设置中关闭硬件加速。'
  },
  {
    test: /(Unknown encoder|Encoder .* not found)/i,
    code: 'ENCODER_MISSING',
    title: '编码器不可用',
    detail: '当前 ffmpeg 构建不包含所选编码器。',
    hint: '请在高级模式换用其他编码器，或安装包含该编码器的 ffmpeg 版本。'
  },
  {
    test: /(Could not find tag for codec|not currently supported in container|Unsupported codec|Codec not currently supported in container)/i,
    code: 'CONTAINER_INCOMPATIBLE',
    title: '容器不支持该编码',
    detail: '所选编码无法封装进目标容器。',
    hint: '例如 WebM 仅支持 VP9/AV1 + Opus，可改用 MKV 或 MP4。'
  },
  {
    test: /(Invalid data found when processing input|moov atom not found|Error while decoding|corrupt)/i,
    code: 'INPUT_CORRUPTED',
    title: '源文件损坏或格式不支持',
    detail: 'ffmpeg 在解析源文件时遇到非法数据。',
    hint: '请先用播放器确认文件可以正常播放；如为下载中断的文件请重新获取。'
  },
  {
    test: /(Conversion failed|Error while opening encoder|Error initializing)/i,
    code: 'ENCODE_FAILED',
    title: '编码过程失败',
    detail: 'ffmpeg 在编码阶段中止。',
    hint: '可尝试降低分辨率 / 提高 CRF 数值 / 改用其他编码器后重试。'
  },
  {
    test: /(Cannot allocate memory|Out of memory)/i,
    code: 'OUT_OF_MEMORY',
    title: '内存不足',
    detail: '编码过程申请内存失败。',
    hint: '请降低输出分辨率，或关闭其他占用内存的程序。'
  }
]

/** 从 stderr 中截取最后若干行，用于错误详情。 */
export function tailLines(text: string, count = 20): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  return lines.slice(-count).join('\n')
}

/** 根据 ffmpeg 退出码与 stderr 生成结构化错误。 */
export function classifyFfmpegFailure(stderr: string, exitCode: number | null): JobError {
  const raw = tailLines(stderr, 20)
  for (const rule of STDERR_RULES) {
    if (rule.test.test(stderr)) {
      return {
        code: rule.code,
        title: rule.title,
        detail: `${rule.detail}（ffmpeg 退出码 ${exitCode ?? '未知'}）`,
        hint: rule.hint,
        raw
      }
    }
  }
  return {
    code: 'FFMPEG_FAILED',
    title: '转换失败',
    detail: `ffmpeg 以退出码 ${exitCode ?? '未知'} 结束，未匹配到已知错误类型。`,
    hint: '请展开下方原始输出查看具体原因；常见原因包括参数不受支持或源文件异常。',
    raw
  }
}

/**
 * stderr 是否暗示「编码器没能打开」（用于硬件编码自动回退）。
 *
 * 其中 `Error while opening encoder` 这类通用错误也可能是软件编码器报的，
 * 因此调用方必须先确认当前用的是硬件编码器，再据此回退。
 */
export function isHardwareFailure(stderr: string): boolean {
  return /(Cannot load|No NVENC capable devices|No capable devices|InitializeEncoder failed|Failed to initialise|OpenEncodeSessionEx failed|hw_frames_ctx|Function not implemented|Error setting option .* to value|Error applying encoder options|Unable to parse .* option value|Driver does not support|MFX session|mfx implementation|Error while opening encoder|Could not open encoder)/i.test(
    stderr
  )
}

/**
 * 从 stderr 中挑出最能说明「为什么 GPU 起不来」的一行。
 *
 * 回退成功时用户往往看不到失败详情，这里保留首条相关错误作为回退原因展示。
 */
export function hardwareFailureReason(stderr: string, encoder: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const match = lines.find((line) =>
    /(Cannot load|No NVENC capable devices|No capable devices|InitializeEncoder failed|Failed to initialise|OpenEncodeSessionEx failed|hw_frames_ctx|Function not implemented|Driver does not support|Error setting option .* to value|Error applying encoder options|Unable to parse .* option value|MFX session|mfx implementation|Error while opening encoder|Could not open encoder)/i.test(
      line
    )
  )
  return match ?? `${encoder} 初始化失败（未返回具体原因，详见日志）`
}
