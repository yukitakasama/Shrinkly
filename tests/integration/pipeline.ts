/**
 * 集成测试真正的执行体（由 run.mjs 通过 vite-node 调用）。
 *
 * 复用应用自身的模块（probe / estimate / args / runner），因此断言本身就等价于
 * 「应用真的能跑」的验证。断言项见 PLAN §8.2。
 */
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { buildFfmpegArgs } from '../../src/main/ffmpeg/args'
import { locateFfmpeg } from '../../src/main/ffmpeg/locator'
import { probeFile } from '../../src/main/ffmpeg/probe'
import { runFfmpeg } from '../../src/main/ffmpeg/runner'
import { JobQueue } from '../../src/main/jobs/queue'
import { Logger } from '../../src/main/logger'
import { computeEstimate } from '../../src/shared/estimate'
import { isTemporaryFile } from '../../src/main/fs/paths'
import type { AudioCodec, ContainerFormat, JobSpec, MediaInfo, VideoCodec } from '../../src/shared/types'

interface Failure {
  check: string
  detail: string
}

const failures: Failure[] = []
const passed: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed.push(name)
    console.log(`  ✓ ${name}`)
  } else {
    failures.push({ check: name, detail })
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function deriveContainer(media: MediaInfo): ContainerFormat {
  const name = (media.container ?? '').toLowerCase()
  if (name.includes('webm')) return 'webm'
  if (name.includes('matroska')) return 'mkv'
  return 'mp4'
}

function deriveCodec(media: MediaInfo): VideoCodec {
  const codec = (media.video?.codec ?? '').toLowerCase()
  if (codec.includes('hevc') || codec.includes('h265')) return 'hevc'
  if (codec.includes('av1')) return 'av1'
  if (codec.includes('vp9')) return 'vp9'
  return 'h264'
}

function buildSpec(media: MediaInfo, quality: number, targetSizeMB: number | null, outputDir: string): JobSpec {
  const container = deriveContainer(media)
  const codec = deriveCodec(media)
  const audioCodec: AudioCodec = container === 'webm' ? 'opus' : 'aac'
  const estimate = computeEstimate({
    media,
    quality,
    videoCodec: codec,
    container,
    audioCodec,
    audioMode: media.audio ? 'encode' : 'none',
    targetSizeMB,
    hwAccel: false
  })
  if (!estimate.ok) throw new Error(`估算失败：${estimate.error?.title}`)
  const encoder =
    codec === 'h264' ? 'libx264' : codec === 'hevc' ? 'libx265' : codec === 'av1' ? 'libaom-av1' : 'libvpx-vp9'
  return {
    inputPath: media.path,
    container,
    video: {
      codec,
      encoder,
      rateControl: estimate.rateControl,
      crf: estimate.crf,
      bitrateKbps: estimate.rateControl === 'crf' ? null : Math.round(estimate.videoBitrateKbps),
      width: estimate.scaledResolution ? estimate.width : null,
      height: estimate.scaledResolution ? estimate.height : null,
      frameRate: estimate.changedFrameRate ? estimate.frameRate : null,
      preset: 'veryfast',
      profile: null,
      level: null,
      pixelFormat: 'yuv420p',
      gop: null,
      bframes: null,
      hwAccel: false
    },
    audio: {
      mode: media.audio ? 'encode' : 'none',
      codec: audioCodec,
      bitrateKbps: media.audio ? Math.max(32, Math.round(estimate.audioBitrateKbps || 128)) : null,
      channels: 0,
      sampleRate: null
    },
    output: {
      directory: outputDir,
      nameTemplate: '{name}_compressed.{ext}',
      conflict: 'rename',
      keepMetadata: true,
      keepChapters: true
    },
    extraArgs: []
  }
}

async function runJob(ffmpegPath: string, spec: JobSpec, outputPath: string): Promise<{ code: number | null; stderr: string }> {
  const args = buildFfmpegArgs({ spec, input: spec.inputPath, output: outputPath, includeProgress: true })
  const outcome = await runFfmpeg({ ffmpegPath, args, durationSec: null }).promise
  return { code: outcome.code, stderr: outcome.stderrTail }
}

/** 完整解码检查：`ffmpeg -v error -i out -f null -` 应无输出。 */
function decodeCheck(ffmpegPath: string, filePath: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ['-v', 'error', '-nostdin', '-i', filePath, '-f', 'null', process.platform === 'win32' ? 'NUL' : '-'], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ ok: code === 0 && stderr.trim().length === 0, stderr }))
  })
}

async function main(): Promise<void> {
  const fixtures = process.argv.slice(2)
  const status = await locateFfmpeg({})
  if (!status.ffmpegPath || !status.ffprobePath) {
    console.log('未找到 ffmpeg，无法执行集成测试。')
    process.exit(1)
  }
  console.log(`ffmpeg: ${status.ffmpegPath} (${status.version ?? 'unknown'})\n`)

  const workDir = await mkdtemp(join(tmpdir(), 'shrinkly-integration-'))
  const outDir = join(workDir, 'out')
  await mkdir(outDir, { recursive: true })

  try {
    for (const fixture of fixtures) {
      console.log(`\n▶ ${basename(fixture)}`)
      const media = await probeFile(status.ffprobePath, fixture)
      check('ffprobe 可读取', Boolean(media.video), media.warnings.join('; '))

      // 1) 质量模式
      const spec = buildSpec(media, 60, null, outDir)
      const outputPath = join(outDir, `${basename(fixture, extname(fixture))}_compressed.${spec.container === 'mkv' ? 'mkv' : spec.container}`)
      const qualityOutcome = await runJob(status.ffmpegPath, spec, outputPath)
      check('质量模式编码成功', qualityOutcome.code === 0, qualityOutcome.stderr.split('\n').slice(-3).join(' | '))

      let produced: MediaInfo | null = null
      try {
        produced = await probeFile(status.ffprobePath, outputPath)
        check('输出可被 ffprobe 读取', true)
      } catch (error) {
        check('输出可被 ffprobe 读取', false, String(error))
      }

      if (produced?.video && media.video) {
        check(
          '分辨率不高于源',
          produced.video.width <= media.video.width && produced.video.height <= media.video.height,
          `${produced.video.width}×${produced.video.height} vs ${media.video.width}×${media.video.height}`
        )
        check(
          '帧率不高于源',
          produced.video.frameRate <= media.video.frameRate + 0.05,
          `${produced.video.frameRate} vs ${media.video.frameRate}`
        )
        check('容器与扩展名一致', extname(outputPath).toLowerCase() === `.${spec.container === 'mkv' ? 'mkv' : spec.container}`)
        if (media.durationSec && produced.durationSec) {
          check(
            '时长误差 ≤ 0.5s',
            Math.abs(media.durationSec - produced.durationSec) <= 0.5,
            `源 ${media.durationSec.toFixed(2)}s / 出 ${produced.durationSec.toFixed(2)}s`
          )
        }
      }

      const decoded = await decodeCheck(status.ffmpegPath, outputPath)
      check('完整解码无错误', decoded.ok, decoded.stderr.slice(-200))

      // 2) 目标体积模式（只对第一个样片做，控制耗时）
      if (fixture === fixtures[0] && media.durationSec && media.durationSec > 0) {
        const sourceMB = media.sizeBytes / (1024 * 1024)
        const targetMB = Math.max(1, Math.round(sourceMB * 0.4 * 10) / 10)
        const targetSpec = buildSpec(media, 60, targetMB, outDir)
        const targetOutput = join(outDir, `target_${basename(fixture, extname(fixture))}.${targetSpec.container === 'mkv' ? 'mkv' : targetSpec.container}`)
        const targetOutcome = await runJob(status.ffmpegPath, targetSpec, targetOutput)
        check('目标体积模式编码成功', targetOutcome.code === 0, targetOutcome.stderr.split('\n').slice(-3).join(' | '))
        try {
          const info = await stat(targetOutput)
          const actualMB = info.size / (1024 * 1024)
          check(
            `目标体积 ${targetMB}MB 误差 ≤ 12%`,
            Math.abs(actualMB - targetMB) / targetMB <= 0.12,
            `实际 ${actualMB.toFixed(2)}MB`
          )
        } catch (error) {
          check('目标体积输出存在', false, String(error))
        }
      }

      // 3) 中文 + 空格路径
      const copyName = `中文 空格 ${basename(fixture)}`
      const copyPath = join(workDir, copyName)
      await copyFile(fixture, copyPath)
      const copyMedia = await probeFile(status.ffprobePath, copyPath)
      const copySpec = buildSpec(copyMedia, 70, null, outDir)
      const copyOutput = join(outDir, `中文 输出 ${basename(fixture, extname(fixture))}.${copySpec.container === 'mkv' ? 'mkv' : copySpec.container}`)
      const copyOutcome = await runJob(status.ffmpegPath, copySpec, copyOutput)
      check('中文 / 空格路径可用', copyOutcome.code === 0, copyOutcome.stderr.split('\n').slice(-3).join(' | '))
    }

    // 4) 取消后无残留 .part（走真实队列，验证 .part 清理）
    console.log('\n▶ 取消与临时文件清理')
    const cancelFixture = fixtures[0]
    const cancelMedia = await probeFile(status.ffprobePath, cancelFixture)
    const cancelSpec = buildSpec(cancelMedia, 80, null, outDir)
    const logger = new Logger(join(workDir, 'logs'))
    const queue = new JobQueue({
      logger,
      getFfmpegPath: () => status.ffmpegPath,
      getFfprobePath: () => status.ffprobePath,
      getCapabilities: () => null,
      getConcurrency: () => 1,
      onJobUpdate: () => undefined,
      onProgress: () => undefined,
      onLog: () => undefined
    })

    const slowSpec: JobSpec = {
      ...cancelSpec,
      video: { ...cancelSpec.video, preset: 'veryslow' },
      output: { ...cancelSpec.output, directory: outDir, nameTemplate: 'cancel_target.{ext}' }
    }
    const cancelJobRecord = queue.enqueue({ spec: slowSpec, media: cancelMedia, estimate: null })
    queue.start()
    await new Promise((resolve) => setTimeout(resolve, 800))
    queue.cancel(cancelJobRecord.id)

    const cancelled = await new Promise<boolean>((resolve) => {
      const started = Date.now()
      const timer = setInterval(() => {
        const current = queue.get(cancelJobRecord.id)
        if (current && ['canceled', 'failed', 'done'].includes(current.status)) {
          clearInterval(timer)
          resolve(current.status === 'canceled')
          return
        }
        if (Date.now() - started > 20_000) {
          clearInterval(timer)
          resolve(false)
        }
      }, 200)
    })
    check('取消后任务状态为「已取消」', cancelled)

    await new Promise((resolve) => setTimeout(resolve, 500))
    const leftovers = (await readdir(outDir)).filter((name) => isTemporaryFile(name))
    check('取消后无 .part 残留', leftovers.length === 0, leftovers.join(', '))

  } finally {
    await rm(workDir, { recursive: true, force: true })
  }

  console.log(`\n通过 ${passed.length} 项，失败 ${failures.length} 项。`)
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  ✗ ${failure.check} ${failure.detail}`)
    process.exit(1)
  }
}

void main()
