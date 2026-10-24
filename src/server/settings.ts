/**
 * 配置读写：单一 JSON 文件 + 原子写入（临时文件 rename），避免断电产生半截文件。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { DEFAULT_QUALITY } from '../shared/presets'
import type { AppSettings } from '../shared/types'

export const DEFAULT_SETTINGS: AppSettings = {
  ffmpegPath: null,
  defaultQuality: DEFAULT_QUALITY,
  defaultConflict: 'rename',
  outputDirectory: null,
  nameTemplate: '{name}_compressed.{ext}',
  concurrency: 1,
  hwAccel: false,
  defaultHwMode: 'auto'
}

const settingsSchema = z.object({
  ffmpegPath: z.string().max(1024).nullable(),
  defaultQuality: z.number().min(0).max(100),
  defaultConflict: z.enum(['ask', 'rename', 'overwrite', 'skip']),
  outputDirectory: z.string().max(1024).nullable(),
  nameTemplate: z.string().min(1).max(200),
  concurrency: z.number().int().min(1).max(4),
  hwAccel: z.boolean(),
  defaultHwMode: z.enum(['auto', 'cpu', 'gpu']).default('auto')
})

export class SettingsStore {
  private settings: AppSettings = { ...DEFAULT_SETTINGS }

  constructor(private readonly filePath: string) {}

  get(): AppSettings {
    return { ...this.settings }
  }

  async load(): Promise<AppSettings> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = settingsSchema.safeParse(JSON.parse(raw))
      if (parsed.success) {
        this.settings = { ...DEFAULT_SETTINGS, ...parsed.data }
      }
    } catch {
      // 文件不存在或损坏 → 使用默认值（不覆盖用户文件）
    }
    return this.get()
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const merged = { ...this.settings, ...patch }
    const parsed = settingsSchema.safeParse(merged)
    if (!parsed.success) {
      throw new Error(`配置不合法：${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`)
    }
    this.settings = parsed.data
    await this.persist()
    return this.get()
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    await writeFile(temporary, JSON.stringify(this.settings, null, 2), 'utf8')
    await rename(temporary, this.filePath)
  }
}
