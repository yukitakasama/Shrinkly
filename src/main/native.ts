/**
 * 原生交互 IPC：文件 / 目录 / 可执行文件选择与资源管理器定位。
 *
 * 渲染层的业务请求仍走本地 HTTP，这里只补齐浏览器做不到的原生能力。
 */
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { NATIVE_CHANNELS } from '../shared/bridge'

const MEDIA_EXTENSIONS = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'm4v', 'ts', 'mpg', 'mpeg']

function parentWindow(getWindow: () => BrowserWindow | null): BrowserWindow | undefined {
  const window = getWindow()
  return window && !window.isDestroyed() ? window : undefined
}

/** 注册一次即可，重复注册会抛错。 */
export function registerNativeHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(NATIVE_CHANNELS.pickFiles, async () => {
    const parent = parentWindow(getWindow)
    const options: Electron.OpenDialogOptions = {
      title: '选择视频文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '视频文件', extensions: MEDIA_EXTENSIONS },
        { name: '全部文件', extensions: ['*'] }
      ]
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle(NATIVE_CHANNELS.pickDirectory, async () => {
    const parent = parentWindow(getWindow)
    const options: Electron.OpenDialogOptions = {
      title: '选择文件夹',
      properties: ['openDirectory']
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(NATIVE_CHANNELS.pickExecutable, async () => {
    const parent = parentWindow(getWindow)
    const options: Electron.OpenDialogOptions = {
      title: '选择 ffmpeg 可执行文件',
      properties: ['openFile'],
      filters: [{ name: '可执行文件', extensions: ['exe'] }]
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(NATIVE_CHANNELS.reveal, (_event, target: unknown) => {
    if (typeof target === 'string' && target.trim().length > 0) shell.showItemInFolder(target)
  })
}
