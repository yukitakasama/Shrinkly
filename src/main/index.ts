/**
 * Electron 主进程入口：窗口、安全策略、单实例锁、IPC 与状态装配。
 */
import { join } from 'node:path'
import { app, BrowserWindow, session, shell } from 'electron'
import { IPC } from '../shared/ipc'
import { registerIpcHandlers } from './ipc/handlers'
import { AppState } from './state'

process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let state: AppState | null = null

function send(channel: string, payload: unknown): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  window.webContents.send(channel, payload)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: '#12151c',
    title: 'Shrinkly',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 禁止渲染层打开新窗口；外链一律交给系统浏览器。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 禁止导航离开应用页面（开发模式允许 dev server 自身）。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    if (url.startsWith('file://')) return
    event.preventDefault()
  })

  // 渲染层错误与加载失败写进主进程日志，便于用户反馈问题。
  mainWindow.webContents.on('did-finish-load', () => {
    state?.logger.info('window', '渲染层已加载')
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    state?.logger.error('window', `渲染层加载失败 ${errorCode} ${errorDescription} ${validatedURL}`)
  })
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) state?.logger.warn('renderer', `${message} (${sourceId}:${line})`)
  })

  // 拒绝所有权限请求（本应用不需要摄像头 / 麦克风等）。
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(async () => {
    app.setAppUserModelId('com.shrinkly.app')

    // 生产环境额外收紧 CSP（HTML 内 meta 已有一层）。
    if (!isDev) {
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"
            ]
          }
        })
      })
    }

    state = new AppState(app.getPath('userData'), {
      jobUpdate: (job) => send(IPC.eventJobUpdate, job),
      jobProgress: (payload) => send(IPC.eventJobProgress, payload),
      jobLog: (payload) => send(IPC.eventJobLog, payload),
      logEntry: (entry) => send(IPC.eventLogEntry, entry),
      installProgress: (progress) => send(IPC.eventInstallProgress, progress)
    })
    registerIpcHandlers(state, () => mainWindow)
    createWindow()
    await state.init()
    send(IPC.eventLogEntry, { time: Date.now(), level: 'info', scope: 'app', message: '界面已就绪' })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    state?.queue.cancelAll()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
