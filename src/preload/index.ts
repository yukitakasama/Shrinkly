/**
 * preload：只暴露原生交互能力（文件对话框 / 拖拽取路径 / 定位文件）。
 *
 * 业务接口仍走本地 HTTP（REST + SSE），因此原生窗口与浏览器测试用的是同一份
 * 渲染层代码。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { NATIVE_CHANNELS } from '../shared/bridge'
import type { ShrinklyBridge } from '../shared/bridge'

const bridge: ShrinklyBridge = {
  getPathForFile: (file: unknown): string => {
    try {
      return webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0])
    } catch {
      return ''
    }
  },
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke(NATIVE_CHANNELS.pickFiles),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(NATIVE_CHANNELS.pickDirectory),
  pickExecutable: (): Promise<string | null> => ipcRenderer.invoke(NATIVE_CHANNELS.pickExecutable),
  reveal: (targetPath: string): Promise<void> => ipcRenderer.invoke(NATIVE_CHANNELS.reveal, targetPath)
}

contextBridge.exposeInMainWorld('shrinkly', bridge)
