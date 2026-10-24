/** 渲染层格式化工具（纯函数）。 */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '—'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function formatFps(fps: number | null | undefined): string {
  if (!fps || !Number.isFinite(fps)) return '—'
  const rounded = Math.round(fps * 100) / 100
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)} fps`
}

export function formatBitrate(kbps: number | null | undefined): string {
  if (!kbps || !Number.isFinite(kbps) || kbps <= 0) return '—'
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${Math.round(kbps)} kbps`
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value.toFixed(1)}%`
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m} 分 ${s} 秒`
}

/** 相对源文件的体积变化说明，例如「↓42%」或「↑3%」。 */
export function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '—'
  const diff = (1 - ratio) * 100
  if (Math.abs(diff) < 0.5) return '≈ 无变化'
  return diff > 0 ? `↓${diff.toFixed(0)}%` : `↑${Math.abs(diff).toFixed(0)}%`
}
