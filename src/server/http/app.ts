/**
 * 本地 HTTP 服务：把 WebGUI + REST API + SSE 组合起来。
 *
 * 安全约束（本地单用户工具）：
 * - 只监听 127.0.0.1；
 * - 每个请求都要带启动时随机生成的 token（header 或 query）；
 * - 校验 Host 头，拒绝 DNS rebinding；
 * - 不返回 CORS 头，浏览器跨源请求无法读取响应。
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { TOKEN_QUERY } from '../../shared/api'
import type { AppState } from '../state'
import { registerRoutes, errorToResponse } from './routes'
import {
  Router,
  SseHub,
  createToken,
  extractToken,
  readJsonBody,
  safeEqual,
  sendJson
} from './router'
import { serveStatic, sendNotFound } from './static'

export interface ServerConfig {
  /** 用户数据目录（settings.json / logs / 能力缓存）。 */
  dataDir: string
  /** 构建后的 WebGUI 目录（out/renderer）。 */
  webRoot: string
  version: string
  /** 固定端口；0 或未提供时使用随机空闲端口。 */
  port?: number
  host?: string
  /** 收到 POST /api/shutdown 时的回调（Electron 外壳据此退出进程）。 */
  onShutdownRequested?: () => void
}

export interface ServerHandle {
  state: AppState
  url: string
  port: number
  token: string
  /** 是否已收到过 WebGUI 首页请求（用于判断浏览器是否真的打开了）。 */
  getWebGuiHits: () => number
  close: () => Promise<void>
}

const ALLOWED_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

function chooseLoopback(req: IncomingMessage): boolean {
  const host = req.headers.host ?? ''
  if (!ALLOWED_HOSTS.test(host)) return false
  const remote = req.socket.remoteAddress ?? ''
  return remote === '' || remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

/** 启动服务（含状态初始化）。 */
export async function startShrinklyServer(config: ServerConfig): Promise<ServerHandle> {
  const hub = new SseHub()
  const token = createToken()

  const { AppState } = await import('../state')
  const state = new AppState(config.dataDir, {
    jobUpdate: (job) => hub.broadcast({ type: 'job-update', data: job }),
    jobProgress: (payload) => hub.broadcast({ type: 'job-progress', data: payload }),
    jobLog: (payload) => hub.broadcast({ type: 'job-log', data: payload }),
    logEntry: (entry) => hub.broadcast({ type: 'log', data: entry }),
    installProgress: (progress) => hub.broadcast({ type: 'install', data: progress })
  })

  const router = new Router()
  registerRoutes(router, {
    state,
    version: config.version,
    requestShutdown: () => {
      config.onShutdownRequested?.()
    }
  })

  let webGuiHits = 0

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!chooseLoopback(req)) {
        sendJson(res, 403, { error: '只允许本机访问' })
        return
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      const method = req.method ?? 'GET'

      if (!url.pathname.startsWith('/api/')) {
        const served = await serveStatic(config.webRoot, url.pathname, res)
        if (!served) sendNotFound(res)
        if (url.pathname === '/' && served) {
          webGuiHits += 1
          if (webGuiHits === 1) state.logger.info('http', '浏览器已加载 WebGUI 页面')
        }
        return
      }

      const matched = router.match(method, url.pathname)
      if (!matched) {
        sendJson(res, 404, { error: `未知接口：${method} ${url.pathname}` })
        return
      }

      if (!matched.route.public) {
        const provided = extractToken(req, url)
        if (!provided || !safeEqual(provided, token)) {
          sendJson(res, 401, { error: '缺少或无效的访问令牌，请从启动时打开的链接进入' })
          return
        }
      }

      let body: unknown
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        body = await readJsonBody(req)
      }

      const result = await matched.route.handler({ req, res, url, params: matched.params, body, sse: hub })
      if (result !== undefined && !res.writableEnded) {
        sendJson(res, 200, result)
      } else if (result === undefined && !res.writableEnded) {
        res.writeHead(204)
        res.end()
      }
    } catch (error) {
      if (res.writableEnded) return
      const { status, payload } = errorToResponse(error)
      sendJson(res, status, payload)
    }
  }

  const server = createHttpServer((req, res) => {
    void handleRequest(req, res)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port ?? 0, config.host ?? '127.0.0.1', () => resolve())
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : (config.port ?? 0)
  const baseUrl = `http://127.0.0.1:${port}`

  await state.init()

  return {
    state,
    port,
    token,
    getWebGuiHits: () => webGuiHits,
    url: `${baseUrl}/?${TOKEN_QUERY}=${token}`,
    close: async () => {
      hub.closeAll()
      state.queue.cancelAll()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // 强制断开 keep-alive 连接，避免 close 一直挂起
        server.closeAllConnections?.()
      })
    }
  }
}

/** 便于脚本/测试直接拿到用户数据目录下的路径。 */
export function defaultWebRoot(baseDir: string): string {
  return join(baseDir, 'renderer')
}
