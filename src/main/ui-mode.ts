/**
 * 主进程的用户界面模式选择（纯函数，便于单测）。
 *
 * - 默认 `window`：打开 Electron 原生窗口（拖拽、系统文件对话框、托盘）；
 * - `--web` / `SHRINKLY_WEB=1`：不建窗口，改为用系统浏览器打开同一份 WebUI，
 *   供前端自动化测试（ego / Playwright 等）使用。
 */
export type UiMode = 'window' | 'web'

export function resolveUiMode(argv: readonly string[], env: Record<string, string | undefined>): UiMode {
  const flag = env['SHRINKLY_WEB']
  if (flag === '1' || flag === 'true') return 'web'
  if (argv.some((arg) => arg === '--web' || arg === '-w')) return 'web'
  return 'window'
}
