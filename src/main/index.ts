/**
 * 桌面外壳：默认打开 Electron **原生窗口**加载界面。
 *
 * - 原生窗口：拖拽导入、系统文件 / 目录选择框、托盘、单实例聚焦；
 * - `--web` / `SHRINKLY_WEB=1`：不建窗口，改用系统浏览器打开同一份 WebUI，
 *   供前端自动化测试使用（`SHRINKLY_NO_BROWSER=1` 可只启动服务）。
 *
 * 两种模式共用同一套渲染层代码：业务请求走本地 HTTP（REST + SSE），
 * preload 只补充浏览器做不到的原生能力。
 */
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { app, BrowserWindow, clipboard, Menu, nativeImage, shell, Tray } from 'electron'
import { startShrinklyServer, type ServerHandle } from '../server/http/app'
import { openInBrowser, type OpenCommand } from './browser'
import { registerNativeHandlers } from './native'
import { resolveUiMode } from './ui-mode'

const DEV_RENDERER_URL = process.env['ELECTRON_RENDERER_URL'] ?? null
const DEV_API_PORT = process.env['SHRINKLY_API_PORT'] ? Number(process.env['SHRINKLY_API_PORT']) : 12800
const UI_MODE = resolveUiMode(process.argv.slice(1), process.env)
const SKIP_BROWSER = process.env['SHRINKLY_NO_BROWSER'] === '1'

let runtimeFilePath: string | null = null
let tray: Tray | null = null
let server: ServerHandle | null = null
let mainWindow: BrowserWindow | null = null
let quitting = false

function resourceImage(): Electron.NativeImage {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'icon.png')]
    : [join(__dirname, '../../build/icon.png'), join(process.cwd(), 'build/icon.png')]
  for (const candidate of candidates) {
    const image = nativeImage.createFromPath(candidate)
    if (!image.isEmpty()) return image
  }
  return nativeImage.createEmpty()
}

function trayImage(): Electron.NativeImage {
  const image = resourceImage()
  return image.isEmpty() ? image : image.resize({ width: 16, height: 16 })
}

/** 界面地址：开发模式走 vite dev server，打包后走本地 HTTP 服务。 */
function uiUrl(): string | null {
  if (!server) return null
  return DEV_RENDERER_URL ? `${DEV_RENDERER_URL}/?token=${server.token}&api=${server.port}` : server.url
}

/** 用系统方式打开 URL：openExternal 失败时回退到平台自带的命令。 */
async function launchBrowser(url: string): Promise<void> {
  const baseline = server?.getWebGuiHits() ?? 0
  await openInBrowser({
    url,
    log: (level, message) => server?.state.logger[level]('shell', message),
    openExternal: (target) => shell.openExternal(target, { activate: true }),
    run: (command: OpenCommand) => {
      // 必须**同步**调用：实测异步 spawn/detached 启动的 `cmd start` 会随父进程被回收。
      // 超时压到 5s，避免异常命令把主进程的事件循环（也就是 HTTP 服务）卡太久。
      execFileSync(command.file, command.args, { stdio: 'ignore', timeout: 5000, windowsHide: true })
    },
    waitForHit: (timeoutMs) => waitForWebGuiHit(timeoutMs, baseline)
  })
}

/** 轮询等待浏览器加载 WebGUI 首页。 */
async function waitForWebGuiHit(timeoutMs: number, baseline: number): Promise<boolean> {
  if (!server) return false
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (server.getWebGuiHits() > baseline) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

/** 打开原生窗口（已存在则聚焦）。 */
function createWindow(): void {
  const target = uiUrl()
  if (!target) return
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: '#12151c',
    title: 'Shrinkly',
    autoHideMenuBar: true,
    icon: resourceImage(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 禁止渲染层开新窗口；外链交给系统浏览器。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 只允许停留在本应用地址（开发模式为 vite dev server）。
  const origin = new URL(target).origin
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) {
      event.preventDefault()
      if (/^https?:/i.test(url)) void shell.openExternal(url)
    }
  })

  mainWindow.webContents.on('did-finish-load', () => {
    server?.state.logger.info('window', '原生窗口已加载界面')
    // 诊断：确认 preload 桥接确实注入，否则拖拽 / 系统对话框会静默失效。
    void mainWindow?.webContents
      .executeJavaScript('Boolean(window.shrinkly && window.shrinkly.pickFiles)')
      .then((ready: boolean) => {
        server?.state.logger.info('window', ready ? '原生桥接已就绪' : '原生桥接缺失（拖拽与系统对话框不可用）')
      })
      .catch(() => undefined)
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    server?.state.logger.error('window', `界面加载失败 ${errorCode} ${errorDescription} ${validatedURL}`)
  })
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) server?.state.logger.warn('renderer', `${message} (${sourceId}:${line})`)
  })

  // 本应用不需要摄像头 / 麦克风等权限。
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))

  void mainWindow.loadURL(target)
  server?.state.logger.info('window', '原生窗口已创建')
}

/** 打开用户界面：原生窗口或系统浏览器（测试模式）。 */
function openUi(): void {
  const target = uiUrl()
  if (!target) return
  if (UI_MODE === 'window') {
    createWindow()
    return
  }
  if (!SKIP_BROWSER) void launchBrowser(target)
}

function buildTray(): void {
  tray = new Tray(trayImage())
  tray.setToolTip('Shrinkly — 视频压缩与格式转换')

  const menu = Menu.buildFromTemplate([
    { label: UI_MODE === 'window' ? '打开窗口' : '打开浏览器界面', click: openUi },
    {
      label: '复制访问地址',
      click: () => {
        const target = uiUrl()
        if (target) clipboard.writeText(target)
      }
    },
    {
      label: '打开日志目录',
      click: () => {
        void shell.openPath(join(app.getPath('userData'), 'logs'))
      }
    },
    { type: 'separator' },
    {
      label: '退出 Shrinkly',
      click: () => {
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
  tray.on('click', openUi)
  tray.on('double-click', openUi)
}

async function bootstrap(): Promise<void> {
  const webRoot = join(__dirname, '../renderer')
  server = await startShrinklyServer({
    dataDir: app.getPath('userData'),
    webRoot,
    version: app.getVersion(),
    // 开发模式下固定端口，方便 vite 代理；打包后使用随机端口避免冲突。
    port: DEV_RENDERER_URL ? DEV_API_PORT : 0,
    onShutdownRequested: () => app.quit()
  })

  registerNativeHandlers(() => mainWindow)
  buildTray()

  const target = uiUrl() as string

  // 运行期信息（含测试模式地址）写入 userData/runtime.json。
  const runtimeFile = join(app.getPath('userData'), 'runtime.json')
  try {
    await writeFile(
      runtimeFile,
      JSON.stringify(
        { url: target, port: server.port, token: server.token, pid: process.pid, mode: UI_MODE, startedAt: Date.now() },
        null,
        2
      ),
      'utf8'
    )
  } catch {
    // 写失败不影响启动
  }
  runtimeFilePath = runtimeFile
  server.state.logger.info('app', UI_MODE === 'window' ? '界面模式：原生窗口' : '界面模式：Web（测试）')
  console.log(`[shrinkly] ${UI_MODE === 'window' ? '窗口' : 'WebUI'}: ${target}`)

  openUi()
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 再次双击 exe：聚焦已有窗口；Web 模式下重新打开浏览器。
    openUi()
  })

  void app.whenReady().then(async () => {
    app.setAppUserModelId('com.shrinkly.app')
    try {
      await bootstrap()
    } catch (error) {
      // 启动失败时要留下可诊断信息
      console.error('[shrinkly] 启动失败', error)
      await shell.openPath(app.getPath('userData'))
      app.exit(1)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openUi()
    })
  })

  app.on('window-all-closed', () => {
    // 原生窗口模式下关闭窗口即退出；Web 模式没有窗口，靠托盘 / API 退出。
    if (UI_MODE === 'window') app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void (async () => {
      try {
        server?.state.queue.cancelAll()
        tray?.destroy()
        tray = null
        mainWindow?.destroy()
        mainWindow = null
        if (runtimeFilePath) await unlink(runtimeFilePath).catch(() => undefined)
        await server?.close()
      } finally {
        app.quit()
      }
    })()
  })

  process.on('SIGINT', () => app.quit())
  process.on('SIGTERM', () => app.quit())
}
