/**
 * 编码器 / 硬件加速能力探测（PLAN §4.1、§5.7）。
 *
 * 结果按 ffmpeg 可执行文件 mtime 缓存到 userData，避免每次启动都跑一遍
 * `-encoders`（该命令输出很长）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { HW_BACKEND_LABELS, hwEncodersForCodec } from '../../shared/hardware'
import type {
  Capabilities,
  EncoderCapability,
  HardwareEncoderTest,
  HardwareStatus,
  HwAccelKind,
  VideoCodec
} from '../../shared/types'
import { runCapture } from './exec'
import { fileMtime } from './locator'

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface ParsedEncoderList {
  video: string[]
  audio: string[]
  subtitle: string[]
}

/** 解析 `ffmpeg -encoders` 输出（纯函数）。 */
export function parseEncoderList(stdout: string): ParsedEncoderList {
  const result: ParsedEncoderList = { video: [], audio: [], subtitle: [] }
  for (const rawLine of stdout.split(/\r?\n/)) {
    const match = rawLine.match(/^\s*([VAS])([A-Za-z.]{5})\s+(\S+)\s{2,}/)
    if (!match) continue
    const [, kind, , name] = match
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) continue
    if (kind === 'V') result.video.push(name)
    else if (kind === 'A') result.audio.push(name)
    else result.subtitle.push(name)
  }
  return result
}

/** 解析 `ffmpeg -hwaccels` 输出（纯函数）。 */
export function parseHwaccelList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== 'Hardware acceleration methods:' && !line.endsWith(':'))
}

/** 把可用编码器与编码族 / 硬件后端对应起来。 */
export function buildEncoderCapabilities(videoEncoders: string[], hwaccels: string[]): EncoderCapability[] {
  void hwaccels
  const available = new Set(videoEncoders)
  const result: EncoderCapability[] = []
  const families: Array<{ codec: VideoCodec; software: string; hw: Array<{ kind: Exclude<HwAccelKind, 'none'>; id: string }> }> = [
    { codec: 'h264', software: 'libx264', hw: [{ kind: 'nvenc', id: 'h264_nvenc' }, { kind: 'qsv', id: 'h264_qsv' }, { kind: 'amf', id: 'h264_amf' }] },
    { codec: 'hevc', software: 'libx265', hw: [{ kind: 'nvenc', id: 'hevc_nvenc' }, { kind: 'qsv', id: 'hevc_qsv' }, { kind: 'amf', id: 'hevc_amf' }] },
    { codec: 'av1', software: 'libaom-av1', hw: [{ kind: 'nvenc', id: 'av1_nvenc' }, { kind: 'qsv', id: 'av1_qsv' }, { kind: 'amf', id: 'av1_amf' }] },
    { codec: 'vp9', software: 'libvpx-vp9', hw: [{ kind: 'nvenc', id: 'vp9_nvenc' }, { kind: 'qsv', id: 'vp9_qsv' }, { kind: 'amf', id: 'vp9_amf' }] }
  ]

  for (const family of families) {
    result.push({ id: family.software, codec: family.codec, kind: 'software', available: available.has(family.software) })
    for (const hw of family.hw) {
      // 是否真正可用由 `testHardwareEncoder` 实测决定，这里只判断编码器是否存在。
      result.push({ id: hw.id, codec: family.codec, kind: hw.kind, available: available.has(hw.id) })
    }
  }
  return result
}

/** 清空实测缓存（用户点「重新检测」时使用）。 */
export function clearHardwareTestCache(): void {
  hwTestCache.clear()
}

/** 单次硬件编码实测（一次极短的 lavfi 编码），结果在进程内缓存。 */
const hwTestCache = new Map<string, boolean>()

export async function testHardwareEncoder(ffmpegPath: string, encoder: string, timeoutMs = 15_000): Promise<boolean> {
  const cacheKey = `${ffmpegPath}::${encoder}`
  const cached = hwTestCache.get(cacheKey)
  if (cached !== undefined) return cached

  const args = [
    '-hide_banner',
    '-nostdin',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=256x144:d=0.2',
    '-c:v',
    encoder,
    '-f',
    'null',
    '-'
  ]
  const result = await runCapture(ffmpegPath, args, { timeoutMs })
  const usable = result.code === 0 && !result.timedOut
  hwTestCache.set(cacheKey, usable)
  return usable
}

const HW_CODECS: VideoCodec[] = ['h264', 'hevc', 'av1', 'vp9']

/**
 * 逐项实测硬件编码器。
 *
 * 只测「ffmpeg 编译进来」的编码器；实测能真正跑通一次编码才算可用，
 * 这样驱动缺失 / 显卡被占用的机器不会在界面里显示「可用 GPU」。
 */
export async function probeHardwareEncoders(
  ffmpegPath: string,
  capabilities: Capabilities | null
): Promise<HardwareStatus> {
  const compiled = new Set(
    (capabilities?.videoEncoders ?? [])
      .filter((encoder) => encoder.kind !== 'software' && encoder.available)
      .map((encoder) => encoder.id)
  )

  const jobs: Array<{ codec: VideoCodec; encoder: string; kind: Exclude<HwAccelKind, 'none'> }> = []
  for (const codec of HW_CODECS) {
    for (const candidate of hwEncodersForCodec(codec)) {
      jobs.push({ codec, encoder: candidate.encoder, kind: candidate.kind })
    }
  }

  const tests: HardwareEncoderTest[] = await Promise.all(
    jobs.map(async (job) => {
      if (!compiled.has(job.encoder)) {
        return {
          ...job,
          usable: false,
          reason: `当前 ffmpeg 未包含 ${job.encoder}（${HW_BACKEND_LABELS[job.kind]}）`
        }
      }
      const usable = await testHardwareEncoder(ffmpegPath, job.encoder)
      return {
        ...job,
        usable,
        reason: usable
          ? `已检测到 ${HW_BACKEND_LABELS[job.kind]}（${job.encoder}）`
          : `${job.encoder} 初始化失败：可能是显卡驱动过旧、设备被占用或当前会话无 GPU 权限`
      }
    })
  )

  const usable: HardwareStatus['usable'] = []
  for (const codec of HW_CODECS) {
    const hit = tests.find((test) => test.codec === codec && test.usable)
    if (hit) usable.push({ codec, encoder: hit.encoder, kind: hit.kind })
  }

  const message =
    usable.length > 0
      ? `可用硬件编码：${usable.map((entry) => `${entry.codec.toUpperCase()} → ${entry.encoder}`).join('，')}`
      : '未检测到可用的硬件编码器，将使用 CPU 编码'

  return { state: 'ready', tests, usable, message, probedAt: Date.now() }
}

interface CapabilityCacheFile {
  ffmpegPath: string
  mtimeMs: number | null
  probedAt: number
  capabilities: Capabilities
}

async function readCache(cachePath: string, ffmpegPath: string, mtimeMs: number | null): Promise<Capabilities | null> {
  try {
    const raw = await readFile(cachePath, 'utf8')
    const parsed = JSON.parse(raw) as CapabilityCacheFile
    if (!parsed.capabilities) return null
    if (parsed.ffmpegPath !== ffmpegPath) return null
    if (parsed.mtimeMs !== mtimeMs) return null
    if (Date.now() - parsed.probedAt > CACHE_TTL_MS) return null
    return parsed.capabilities
  } catch {
    return null
  }
}

async function writeCache(cachePath: string, payload: CapabilityCacheFile): Promise<void> {
  try {
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(cachePath, JSON.stringify(payload, null, 2), 'utf8')
  } catch {
    // 缓存写入失败不影响主流程
  }
}

/** 探测 ffmpeg 能力（带磁盘缓存）。 */
export async function probeCapabilities(ffmpegPath: string, cachePath: string): Promise<Capabilities> {
  const mtimeMs = await fileMtime(ffmpegPath)
  const cached = await readCache(cachePath, ffmpegPath, mtimeMs)
  if (cached) return cached

  const encoderResult = await runCapture(ffmpegPath, ['-hide_banner', '-encoders'], { timeoutMs: 20_000 })
  const hwaccelResult = await runCapture(ffmpegPath, ['-hide_banner', '-hwaccels'], { timeoutMs: 20_000 })
  const parsed = parseEncoderList(encoderResult.stdout)
  const hwaccels = parseHwaccelList(hwaccelResult.stdout)
  const hwaccelKinds = hwaccels.filter((name): name is HwAccelKind => ['nvenc', 'qsv', 'amf', 'cuda', 'd3d11va', 'dxva2', 'vaapi', 'videotoolbox'].includes(name))

  const videoEncoders = buildEncoderCapabilities(parsed.video, hwaccels)
  const capabilities: Capabilities = {
    version: null,
    encoders: parsed.video,
    videoEncoders,
    hwaccels: hwaccelKinds,
    audioEncoders: parsed.audio,
    probedAt: Date.now()
  }

  await writeCache(cachePath, { ffmpegPath, mtimeMs, probedAt: capabilities.probedAt, capabilities })
  return capabilities
}

/** 可用编码器 id（含硬件编码器）。 */
export function availableEncoderIds(capabilities: Capabilities | null): string[] {
  if (!capabilities) return []
  return capabilities.videoEncoders.filter((encoder) => encoder.available).map((encoder) => encoder.id)
}

/** 按优先级挑选可用的硬件编码器；无可用则返回 null。 */
export function pickHardwareEncoder(capabilities: Capabilities | null, codec: VideoCodec): string | null {
  if (!capabilities) return null
  const order: Array<Exclude<HwAccelKind, 'none'>> = ['nvenc', 'qsv', 'amf']
  for (const backend of order) {
    const hit = capabilities.videoEncoders.find(
      (encoder) => encoder.codec === codec && encoder.kind === backend && encoder.available
    )
    if (hit) return hit.id
  }
  return null
}
