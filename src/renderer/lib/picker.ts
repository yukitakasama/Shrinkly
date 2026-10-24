/**
 * 浏览器无法获取本地文件路径，因此「选择文件」通过服务端文件浏览器完成。
 * 这里提供与 Promise 风格对接的小助手。
 */
import { useAppStore } from '../store'

export async function pickFiles(): Promise<string[]> {
  return (await useAppStore.getState().openPicker('files')) ?? []
}

export async function pickDirectory(): Promise<string | null> {
  const selection = await useAppStore.getState().openPicker('directory')
  return selection?.[0] ?? null
}

export async function pickExecutable(): Promise<string | null> {
  const selection = await useAppStore.getState().openPicker('executable')
  return selection?.[0] ?? null
}
