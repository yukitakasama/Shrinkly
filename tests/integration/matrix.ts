/**
 * 容器 × 编码全矩阵验证（可选，需要 ffmpeg，不依赖样片）。
 *
 * 自动生成一段 2 秒合成素材，枚举 `CONTAINER_INFO` 里所有合法组合，
 * 逐个编码并做完整解码检查，确保「界面允许的组合」真的能产出可播放文件。
 *
 * 用法：npm run test:matrix
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFfmpegArgs } from '../../src/main/ffmpeg/args'
import { locateFfmpeg } from '../../src/main/ffmpeg/locator'
import { runFfmpeg } from '../../src/main/ffmpeg/runner'
import { AUDIO_ENCODER, CODEC_PROFILES, CONTAINER_FORMATS, CONTAINER_INFO } from '../../src/shared/presets'
import { crfForQuality } from '../../src/shared/presets'
import type { AudioCodec, ContainerFormat, JobSpec, VideoCodec } from '../../src/shared/types'

function runDetached(command: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

async function main(): Promise<void> {
  const status = await locateFfmpeg({})
  if (!status.ffmpegPath) {
    console.log('未找到 ffmpeg，无法执行矩阵验证。')
    process.exit(1)
  }

  const workDir = await mkdtemp(join(tmpdir(), 'shrinkly-matrix-'))
  const source = join(workDir, 'src.mp4')

  try {
    const generated = await runDetached(status.ffmpegPath, [
      '-hide_banner', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', source
    ])
    if (generated.code !== 0) {
      console.log('生成测试素材失败：' + generated.stderr.slice(-300))
      process.exit(1)
    }

    console.log(`ffmpeg: ${status.ffmpegPath}`)
    console.log('素材: 320×240@30fps, 2 秒, H.264 + AAC\n')

    let failed = 0
    let total = 0
    for (const container of CONTAINER_FORMATS) {
      const info = CONTAINER_INFO[container]
      for (const video of info.video) {
        for (const audio of info.audio) {
          total += 1
          const extension = info.extension
          const output = join(workDir, `out_${container}_${video}_${audio}.${extension}`)
          const spec: JobSpec = {
            inputPath: source,
            container,
            video: {
              codec: video as VideoCodec,
              encoder: CODEC_PROFILES[video].softwareEncoder,
              rateControl: 'crf',
              crf: crfForQuality(video, 60),
              bitrateKbps: null,
              width: null,
              height: null,
              frameRate: null,
              preset: 'ultrafast',
              profile: null,
              level: null,
              pixelFormat: 'yuv420p',
              gop: null,
              bframes: null,
              hwAccel: false
            },
            audio: {
              mode: 'encode',
              codec: audio as AudioCodec,
              bitrateKbps: audio === 'flac' ? null : 96,
              channels: 0,
              sampleRate: null
            },
            output: {
              directory: workDir,
              nameTemplate: 'out.{ext}',
              conflict: 'overwrite',
              keepMetadata: true,
              keepChapters: true
            },
            extraArgs: []
          }

          const args = buildFfmpegArgs({ spec, input: source, output, includeProgress: true })
          const started = Date.now()
          const outcome = await runFfmpeg({ ffmpegPath: status.ffmpegPath, args, durationSec: 2 }).promise
          let ok = outcome.code === 0
          let detail = ''

          if (ok) {
            const decode = await runDetached(status.ffmpegPath, [
              '-v', 'error', '-nostdin', '-i', output, '-f', 'null', process.platform === 'win32' ? 'NUL' : '-'
            ])
            ok = decode.code === 0 && decode.stderr.trim().length === 0
            if (!ok) detail = decode.stderr.slice(-160)
            const size = await stat(output).then((value) => value.size).catch(() => 0)
            if (ok && size === 0) {
              ok = false
              detail = '输出文件为空'
            }
          } else {
            detail = outcome.stderrTail.split('\n').slice(-2).join(' | ')
          }

          const elapsed = ((Date.now() - started) / 1000).toFixed(1)
          console.log(
            `${ok ? '✓' : '✗'} ${container.padEnd(5)} ${video.padEnd(5)} + ${AUDIO_ENCODER[audio].padEnd(11)} ${elapsed}s` +
              (detail ? `  ${detail}` : '')
          )
          if (!ok) failed += 1
        }
      }
    }

    const produced = (await readdir(workDir)).filter((name) => name.startsWith('out_'))
    console.log(`\n共 ${total} 个组合，成功 ${total - failed} 个，失败 ${failed} 个，产出 ${produced.length} 个文件。`)
    if (failed > 0) process.exit(1)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

void main()
