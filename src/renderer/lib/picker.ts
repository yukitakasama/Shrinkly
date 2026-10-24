/**
 * 选择文件 / 文件夹 / 可执行文件。
 *
 * 原生窗口里走 Electron 系统对话框（preload 暴露的 `window.shrinkly`）；
 * 浏览器测试模式没有该桥接，退回服务端文件浏览器。
 */
import { useAppStore } from '../store'

const bridge = (): Window['shrinkly'] => window.shrinkly

export async function pickFiles(): Promise<string[]> {
  if (bridge()?.pickFiles) return bridge()!.pickFiles()
  return (await useAppStore.getState().openPicker('files')) ?? []
}

export async function pickDirectory(): Promise<string | null> {
  if (bridge()?.pickDirectory) return bridge()!.pickDirectory()
  const selection = await useAppStore.getState().openPicker('directory')
  return selection?.[0] ?? null
}

export async function pickExecutable(): Promise<string | null> {
  if (bridge()?.pickExecutable) return bridge()!.pickExecutable()
  const selection = await useAppStore.getState().openPicker('executable')
  return selection?.[0] ?? null
}

/** 是否为原生窗口（决定是否显示拖拽区等原生专属交互）。 */
export function isNativeWindow(): boolean {
  return Boolean(bridge())
}
