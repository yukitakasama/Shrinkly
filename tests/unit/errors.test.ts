import { describe, expect, it } from 'vitest'
import { classifyFfmpegFailure, hardwareFailureReason, isHardwareFailure } from '../../src/server/ffmpeg/errors'

describe('硬件编码失败识别', () => {
  it('识别驱动 / 设备类错误', () => {
    expect(isHardwareFailure('[h264_nvenc @ 0x1] No NVENC capable devices found')).toBe(true)
  })

  it('识别「参数不被该硬件编码器接受」的错误（例如把 p5 传给 QSV）', () => {
    const stderr = [
      '[h264_qsv @ 000001f33a51e900] Unable to parse "preset" option value "p5"',
      '[h264_qsv @ 000001f33a51e900] Error setting option preset to value p5.',
      'Error applying encoder options: Invalid argument'
    ].join('\n')
    expect(isHardwareFailure(stderr)).toBe(true)
  })

  it('识别 QSV 会话创建失败（mfx 不受支持）', () => {
    const stderr = [
      '[h264_qsv @ 0x1] Error creating a MFX session: -9.',
      '[h264_qsv @ 0x1] The current mfx implementation is not supported, try next mfx implementation.',
      '[vost#0:0/h264_qsv @ 0x2] Error while opening encoder - maybe incorrect parameters.'
    ].join(String.fromCharCode(10))
    expect(isHardwareFailure(stderr)).toBe(true)
    expect(hardwareFailureReason(stderr, 'h264_qsv')).toContain('MFX session')
  })

  it('与硬件无关的失败不会被误判（调用方还会再用编码器类型兜底）', () => {
    expect(isHardwareFailure('Conversion failed!')).toBe(false)
    expect(isHardwareFailure('Invalid data found when processing input')).toBe(false)
  })

  it('回退原因取首条相关错误', () => {
    const stderr = [
      'Input #0, mov,mp4,m4a ...',
      '[h264_qsv @ 0x1] Error setting option preset to value p5.',
      'Error opening output files: Invalid argument'
    ].join('\n')
    expect(hardwareFailureReason(stderr, 'h264_qsv')).toContain('Error setting option preset')
  })

  it('没有匹配行时给出兜底原因，仍然保留编码器名', () => {
    expect(hardwareFailureReason('some generic failure', 'h264_amf')).toContain('h264_amf')
  })

  it('普通失败仍按既有规则分类', () => {
    const error = classifyFfmpegFailure('No space left on device', 1)
    expect(error.code).toBe('DISK_FULL')
  })
})
