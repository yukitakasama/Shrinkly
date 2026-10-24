#!/usr/bin/env node
/**
 * 集成测试入口（可选，需要本地真实样片）。
 *
 * 用法：
 *   1. 把 1–3 段样片放进 tests/fixtures/（不入库）；
 *   2. npm run test:integration
 *
 * 没有样片时直接跳过并提示，不视为失败（见 PLAN §8.2）。
 */
import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..', '..')
const fixturesDir = join(projectRoot, 'tests', 'fixtures')
const MEDIA_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v'])

function collectFixtures() {
  const files = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1)
        continue
      }
      const dot = entry.name.lastIndexOf('.')
      const ext = dot >= 0 ? entry.name.slice(dot).toLowerCase() : ''
      if (!MEDIA_EXT.has(ext)) continue
      try {
        if (statSync(fullPath).size > 1024) files.push(fullPath)
      } catch {
        // 忽略无法访问的文件
      }
    }
  }
  walk(fixturesDir, 0)
  return files.sort()
}

const fixtures = collectFixtures()
if (fixtures.length === 0) {
  console.log('跳过集成测试：tests/fixtures/ 中没有样片。')
  console.log('请放入 1–3 段 10–60s 的视频后重试（样片不会提交到仓库）。')
  process.exit(0)
}

console.log(`发现 ${fixtures.length} 个样片：`)
for (const file of fixtures) console.log('  - ' + file)

const child = spawn(
  process.execPath,
  [join(projectRoot, 'node_modules', 'vite-node', 'vite-node.mjs'), join(here, 'pipeline.ts'), ...fixtures],
  { cwd: projectRoot, stdio: 'inherit' }
)

child.on('close', (code) => {
  process.exit(code ?? 1)
})
