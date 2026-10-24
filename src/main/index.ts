/**
 * 桌面外壳：**不创建任何原生窗口**。
 *
 * 职责只有三件事：
 * 1. 启动本地 HTTP 服务（WebGUI + REST API + SSE）；
 * 2. 用系统默认浏览器打开 WebGUI；
 * 3. 常驻托盘，提供「打开界面 / 复制地址 / 打开日志目录 / 退出」。
 */
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { app, clipboard, Menu, nativeImage, shell, Tray } from 'electron'
import { startShrinklyServer, type ServerHandle } from '../server/http/app'

const DEV_RENDERER_URL = process.env['ELECTRON_RENDERER_URL'] ?? null
const DEV_API_PORT = process.env['SHRINKLY_API_PORT'] ? Number(process.env['SHRINKLY_API_PORT']) : 12800

// 没有原生窗口，禁用 GPU，尽量降低常驻资源占用。
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')

let runtimeFilePath: string | null = null
let tray: Tray | null = null
let server: ServerHandle | null = null
let quitting = false

function resourceIcon(): Electron.NativeImage {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'icon.png')]
    : [join(__dirname, '../../build/icon.png'), join(process.cwd(), 'build/icon.png')]
  for (const candidate of candidates) {
    const image = nativeImage.createFromPath(candidate)
    if (!image.isEmpty()) return image.resize({ width: 16, height: 16 })
  }
  return nativeImage.createEmpty()
}

/** 用系统方式打开 URL：openExternal 失败时回退到平台自带的命令。 */
async function launchBrowser(url: string): Promise<void> {
  if (process.env['SHRINKLY_NO_BROWSER'] === '1') {
    server?.state.logger.info('shell', 'SHRINKLY_NO_BROWSER=1，跳过自动打开浏览器')
    return
  }

  // 基线必须在打开浏览器之前取：openExternal 可能直到页面加载完才返回。
  const baseline = server?.getWebGuiHits() ?? 0

  try {
    await shell.openExternal(url)
  } catch (error) {
    server?.state.logger.warn('shell', `openExternal 失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // 部分环境（无窗口的 Electron、被安全软件拦截）下 openExternal 会静默失败，
  // 这里通过「服务是否真的收到过首页请求」来判断，必要时回退到系统命令。
  const opened = await waitForWebGuiHit(4000, baseline)
  if (opened) {
    server?.state.logger.info('shell', '已用系统默认浏览器打开 WebGUI')
    return
  }

  // 注意：必须**同步**调用。实测在某些环境下 detached/spawn 启动的 `cmd start`
  // 会随父进程一起被回收，浏览器根本不会打开；同步调用只阻塞几十毫秒，可以接受。
  const command = process.platform === 'win32' ? { file: 'cmd', args: ['/c', 'start', '', url] } : process.platform === 'darwin' ? { file: 'open', args: [url] } : { file: 'xdg-open', args: [url] }
  server?.state.logger.warn('shell', `openExternal 未生效，回退执行 ${command.file} 打开浏览器`)
  try {
    execFileSync(command.file, command.args, { stdio: 'ignore', timeout: 15_000, windowsHide: true })
  } catch (error) {
    server?.state.logger.error('shell', `回退打开浏览器也失败：${error instanceof Error ? error.message : String(error)}；请手动访问 runtime.json 中的地址`)
    return
  }
  if (await waitForWebGuiHit(6000, baseline)) {
    server?.state.logger.info('shell', '已用系统默认浏览器打开 WebGUI（回退方式）')
  } else {
    server?.state.logger.error('shell', '浏览器似乎没有打开，请手动访问托盘「复制访问地址」得到的链接')
  }
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

function openWebGui(): void {
  if (!server) return
  void launchBrowser(server.url)
}

function buildTray(): void {
  const icon = resourceIcon()
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('Shrinkly — 视频压缩与格式转换')

  const menu = Menu.buildFromTemplate([
    { label: '打开界面', click: openWebGui },
    {
      label: '复制访问地址',
      click: () => {
        if (server) clipboard.writeText(server.url)
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
  tray.on('click', openWebGui)
  tray.on('double-click', openWebGui)
}

async function bootstrap(): Promise<void> {
  const webRoot = DEV_RENDERER_URL ? join(__dirname, '../renderer') : join(__dirname, '../renderer')
  server = await startShrinklyServer({
    dataDir: app.getPath('userData'),
    webRoot,
    version: app.getVersion(),
    // 开发模式下固定端口，方便 vite 代理；打包后使用随机端口避免冲突。
    port: DEV_RENDERER_URL ? DEV_API_PORT : 0,
    onShutdownRequested: () => app.quit()
  })

  buildTray()

  const target = DEV_RENDERER_URL
    ? `${DEV_RENDERER_URL}/?token=${server.token}&api=${server.port}`
    : server.url

  // 把运行期信息写到 userData/runtime.json，方便排查「浏览器没打开」之类的问题。
  const runtimeFile = join(app.getPath('userData'), 'runtime.json')
  try {
    await writeFile(
      runtimeFile,
      JSON.stringify({ url: target, port: server.port, token: server.token, pid: process.pid, startedAt: Date.now() }, null, 2),
      'utf8'
    )
  } catch {
    // 写失败不影响启动
  }
  runtimeFilePath = runtimeFile
  console.log(`[shrinkly] WebGUI: ${target}`)

  await launchBrowser(target)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 再次双击 exe：把已有的界面重新在浏览器里打开。
    openWebGui()
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
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void (async () => {
      try {
        tray?.destroy()
        tray = null
        if (runtimeFilePath) await unlink(runtimeFilePath).catch(() => undefined)
        await server?.close()
      } finally {
        app.quit()
      }
    })()
  })

  // 没有窗口的应用不会触发 window-all-closed，这里不做任何自动退出。
  process.on('SIGINT', () => app.quit())
  process.on('SIGTERM', () => app.quit())
}
