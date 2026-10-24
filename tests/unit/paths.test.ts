import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  baseNameContext,
  isTemporaryFile,
  renderNameTemplate,
  resolveOutputPath,
  sanitizeFileName,
  splitExtension,
  temporaryPath
} from '../../src/server/fs/paths'

const created: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'shrinkly-paths-'))
  created.push(dir)
  return dir
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

describe('sanitizeFileName', () => {
  it('替换 Windows 非法字符', () => {
    expect(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j')
  })

  it('去掉尾部的点与空格', () => {
    expect(sanitizeFileName('report...  ')).toBe('report')
  })

  it('为保留设备名加前缀', () => {
    expect(sanitizeFileName('CON.mp4')).toBe('_CON.mp4')
    expect(sanitizeFileName('nul')).toBe('_nul')
  })

  it('全部为非法字符时逐个替换为下划线', () => {
    expect(sanitizeFileName('***')).toBe('___')
  })

  it('清理后为空时使用兜底名', () => {
    expect(sanitizeFileName(' . ')).toBe('output')
  })

  it('超长名字被截断', () => {
    expect(sanitizeFileName('a'.repeat(300)).length).toBe(180)
  })
})

describe('命名模板', () => {
  it('替换已知占位符', () => {
    const context = baseNameContext('D:/videos/样片 sample.mp4', 'mp4')
    expect(renderNameTemplate('{name}_compressed.{ext}', context)).toBe('样片 sample_compressed.mp4')
  })

  it('支持分辨率 / 质量 / 序号占位符', () => {
    const context = { ...baseNameContext('D:/videos/a.mkv', 'mkv'), resolution: '720p', q: 60, index: 3 }
    expect(renderNameTemplate('{name}_{resolution}_q{q}_{index}.{ext}', context)).toBe('a_720p_q60_3.mkv')
  })

  it('未知占位符原样保留（交给校验层报错）', () => {
    const context = baseNameContext('D:/videos/a.mp4', 'mp4')
    expect(renderNameTemplate('{name}_{bogus}.{ext}', context)).toContain('{bogus}')
  })

  it('渲染结果会自动清理非法字符', () => {
    const context = { ...baseNameContext('D:/videos/a.mp4', 'mp4'), name: 'x:y' }
    expect(renderNameTemplate('{name}.{ext}', context)).toBe('x_y.mp4')
  })
})

describe('扩展名与临时文件', () => {
  it('拆分扩展名', () => {
    expect(splitExtension('movie.tar.gz')).toEqual({ base: 'movie.tar', ext: 'gz' })
    expect(splitExtension('movie.MP4')).toEqual({ base: 'movie', ext: 'mp4' })
    expect(splitExtension('noext')).toEqual({ base: 'noext', ext: '' })
  })

  it('临时文件路径与最终文件同目录', () => {
    const finalPath = join('D:/out', '影片_compressed.mp4')
    expect(temporaryPath(finalPath)).toBe(join('D:/out', '影片_compressed.part.mp4'))
    expect(isTemporaryFile(temporaryPath(finalPath).split(/[\\/]/).pop() as string)).toBe(true)
  })

  it('识别本应用的临时文件', () => {
    expect(isTemporaryFile('a.part.mp4')).toBe(true)
    expect(isTemporaryFile('a.part')).toBe(true)
    expect(isTemporaryFile('a.mp4')).toBe(false)
    expect(isTemporaryFile('partition.mp4')).toBe(false)
  })
})

describe('同名冲突策略', () => {
  it('目标不存在时直接写入', async () => {
    const dir = await tempDir()
    const resolved = await resolveOutputPath({ directory: dir, requestedName: 'a_compressed.mp4', conflict: 'rename' })
    expect(resolved.action).toBe('write')
    expect(resolved.finalName).toBe('a_compressed.mp4')
  })

  it('rename 策略自动追加序号', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a_compressed.mp4'), 'x')
    const resolved = await resolveOutputPath({ directory: dir, requestedName: 'a_compressed.mp4', conflict: 'rename' })
    expect(resolved.action).toBe('write')
    expect(resolved.finalName).toBe('a_compressed_1.mp4')

    await writeFile(join(dir, 'a_compressed_1.mp4'), 'x')
    const second = await resolveOutputPath({ directory: dir, requestedName: 'a_compressed.mp4', conflict: 'rename' })
    expect(second.finalName).toBe('a_compressed_2.mp4')
  })

  it('skip 策略跳过已存在的文件', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.mp4'), 'x')
    const resolved = await resolveOutputPath({ directory: dir, requestedName: 'a.mp4', conflict: 'skip' })
    expect(resolved.action).toBe('skip')
  })

  it('overwrite 策略直接覆盖', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.mp4'), 'x')
    const resolved = await resolveOutputPath({ directory: dir, requestedName: 'a.mp4', conflict: 'overwrite' })
    expect(resolved.action).toBe('write')
    expect(resolved.finalName).toBe('a.mp4')
  })

  it('ask 策略返回 ask 交给界面确认', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.mp4'), 'x')
    const resolved = await resolveOutputPath({ directory: dir, requestedName: 'a.mp4', conflict: 'ask' })
    expect(resolved.action).toBe('ask')
  })

  it('输出会撞上源文件时强制改名', async () => {
    const dir = await tempDir()
    const source = join(dir, 'a.mp4')
    await writeFile(source, 'x')
    const resolved = await resolveOutputPath({
      directory: dir,
      requestedName: 'a.mp4',
      conflict: 'overwrite',
      avoidPaths: [source]
    })
    expect(resolved.finalName).toBe('a_1.mp4')
    expect((await readdir(dir)).sort()).toEqual(['a.mp4'])
  })
})
