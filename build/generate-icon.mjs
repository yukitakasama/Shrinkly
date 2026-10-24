#!/usr/bin/env node
/**
 * 生成打包图标 build/icon.png（512×512，纯 Node 绘制，无第三方依赖）。
 *
 * 图形语义：深色圆角方块 + 三根逐渐变短的横条 + 向下箭头，象征「压缩」。
 *
 * 用法：node build/generate-icon.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 512
const here = dirname(fileURLToPath(import.meta.url))

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crcBuffer = Buffer.alloc(4)
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crcBuffer])
}

/** 圆角矩形内判定。 */
function insideRoundedRect(x, y, rect, radius) {
  const { left, top, right, bottom } = rect
  if (x < left || x > right || y < top || y > bottom) return false
  const cx = Math.min(Math.max(x, left + radius), right - radius)
  const cy = Math.min(Math.max(y, top + radius), bottom - radius)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

const pixels = Buffer.alloc(SIZE * SIZE * 4)
const bg = { r: 0x12, g: 0x15, b: 0x1c }
const accent = { r: 0x4d, g: 0xa3, b: 0xff }
const accentSoft = { r: 0x2b, g: 0x6f, b: 0xb3 }

const board = { left: 32, top: 32, right: SIZE - 32, bottom: SIZE - 32 }
const bars = [
  { y: 150, h: 26, from: 120, to: 392 },
  { y: 206, h: 26, from: 148, to: 364 },
  { y: 262, h: 26, from: 176, to: 336 }
]
// 向下箭头：三角形 + 竖杆
function inArrow(x, y) {
  const stem = x >= 240 && x <= 272 && y >= 300 && y <= 372
  const tipTop = 368
  const tipBottom = 452
  if (y >= tipTop && y <= tipBottom) {
    const progress = (y - tipTop) / (tipBottom - tipTop)
    const halfWidth = 76 * (1 - progress)
    if (Math.abs(x - 256) <= halfWidth) return true
  }
  return stem
}

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const offset = (y * SIZE + x) * 4
    if (!insideRoundedRect(x, y, board, 96)) {
      pixels[offset + 3] = 0
      continue
    }
    let color = bg
    for (const bar of bars) {
      if (y >= bar.y && y < bar.y + bar.h && x >= bar.from && x <= bar.to) color = accentSoft
    }
    if (inArrow(x, y)) color = accent
    pixels[offset] = color.r
    pixels[offset + 1] = color.g
    pixels[offset + 2] = color.b
    pixels[offset + 3] = 255
  }
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8
ihdr[9] = 6
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const output = join(here, 'icon.png')
writeFileSync(output, png)
console.log(`已生成 ${output}（${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(1)} KB）`)

// ---- ICO（NSIS 安装器图标需要 .ico；单张 256×256 PNG 负载即可）----
const icoSize = 256
const icoHeader = Buffer.alloc(6)
icoHeader.writeUInt16LE(0, 0)
icoHeader.writeUInt16LE(1, 2)
icoHeader.writeUInt16LE(1, 4)
const entry = Buffer.alloc(16)
entry[0] = 0 // 256px
entry[1] = 0 // 256px
entry[2] = 0
entry[3] = 0
entry.writeUInt16LE(1, 4)
entry.writeUInt16LE(32, 6)
entry.writeUInt32LE(png.length, 8)
entry.writeUInt32LE(22, 12)
const ico = Buffer.concat([icoHeader, entry, png])
const icoPath = join(here, 'icon.ico')
writeFileSync(icoPath, ico)
console.log(`已生成 ${icoPath}（${icoSize}×${icoSize}, ${(ico.length / 1024).toFixed(1)} KB）`)
