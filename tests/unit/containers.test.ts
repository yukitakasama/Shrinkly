import { describe, expect, it } from 'vitest'
import { CONTAINER_INFO, remapCodecsForContainer } from '../../src/shared/presets'
import { previewOutputName } from '../../src/renderer/lib/spec'
import type { ContainerFormat } from '../../src/shared/types'

describe('容器切换时的编码自动修正', () => {
  it('MP4 不支持 VP9 时改成 H.264，并给出说明', () => {
    const remapped = remapCodecsForContainer('mp4', 'vp9', 'aac', 'encode')
    expect(remapped.videoCodec).toBe('h264')
    expect(remapped.audioCodec).toBe('aac')
    expect(remapped.changes.join('')).toContain('VP9')
  })

  it('MKV 支持全部编码组合，不做改动', () => {
    const remapped = remapCodecsForContainer('mkv', 'vp9', 'flac', 'encode')
    expect(remapped.videoCodec).toBe('vp9')
    expect(remapped.audioCodec).toBe('flac')
    expect(remapped.changes).toHaveLength(0)
  })

  it('切到 WebM 时自动换成 VP9 + Opus', () => {
    const remapped = remapCodecsForContainer('webm', 'h264', 'aac', 'encode')
    expect(remapped.videoCodec).toBe('vp9')
    expect(remapped.audioCodec).toBe('opus')
    expect(remapped.changes).toHaveLength(2)
  })

  it('MOV 不支持 AV1 / FLAC 时回到 H.264 + AAC', () => {
    const remapped = remapCodecsForContainer('mov', 'av1', 'flac', 'encode')
    expect(remapped.videoCodec).toBe('h264')
    expect(remapped.audioCodec).toBe('aac')
  })

  it('复制音轨模式下不改音频编码（该字段本就不生效）', () => {
    const remapped = remapCodecsForContainer('webm', 'vp9', 'aac', 'copy')
    expect(remapped.videoCodec).toBe('vp9')
    expect(remapped.audioCodec).toBe('aac')
    expect(remapped.changes).toHaveLength(0)
  })

  it('每个容器的扩展名都与 previewOutputName 一致', () => {
    const containers: ContainerFormat[] = ['mp4', 'mkv', 'webm', 'mov']
    for (const container of containers) {
      const name = previewOutputName('样片 sample.mp4', container, '{name}_compressed.{ext}')
      expect(name).toBe(`样片 sample_compressed.${CONTAINER_INFO[container].extension}`)
    }
  })

  it('命名模板缺少扩展名时补上容器扩展名', () => {
    expect(previewOutputName('a.mp4', 'mkv', '{name}_out')).toBe('a_out.mkv')
  })
})
