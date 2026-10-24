/**
 * 极简 HTTP 路由：不使用 Express，避免为一个本地单用户工具引入多余依赖。
 *
 * 提供：路径参数、JSON body 解析、统一错误映射、SSE 事件广播、token 鉴权。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { TOKEN_HEADER, TOKEN_QUERY } from '../../shared/api'
import type { ServerEvent } from '../../shared/api'

export interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: Record<string, string>
  body: unknown
  /** 通过该函数注册的 SSE 连接会收到所有广播事件。 */
  sse: SseHub
}

export type RouteHandler = (context: RouteContext) => Promise<unknown> | unknown

interface Route {
  method: string
  pattern: RegExp
  keys: string[]
  handler: RouteHandler
  /** 跳过 token 校验（仅用于健康检查）。 */
  public?: boolean
}

/** 允许返回「已自行写入响应」的特殊值。 */
export const RESPONSE_HANDLED = Symbol('response-handled')

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly hint?: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

function toPattern(pathname: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = []
  const source = pathname
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1))
        return '([^/]+)'
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return { pattern: new RegExp(`^${source}/?$`), keys }
}

export class Router {
  private readonly routes: Route[] = []

  add(method: string, pathname: string, handler: RouteHandler, options: { public?: boolean } = {}): void {
    const { pattern, keys } = toPattern(pathname)
    this.routes.push({ method: method.toUpperCase(), pattern, keys, handler, ...options })
  }

  get(pathname: string, handler: RouteHandler, options?: { public?: boolean }): void {
    this.add('GET', pathname, handler, options)
  }

  post(pathname: string, handler: RouteHandler, options?: { public?: boolean }): void {
    this.add('POST', pathname, handler, options)
  }

  put(pathname: string, handler: RouteHandler): void {
    this.add('PUT', pathname, handler)
  }

  patch(pathname: string, handler: RouteHandler): void {
    this.add('PATCH', pathname, handler)
  }

  delete(pathname: string, handler: RouteHandler): void {
    this.add('DELETE', pathname, handler)
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue
      const found = route.pattern.exec(pathname)
      if (!found) continue
      const params: Record<string, string> = {}
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(found[index + 1] ?? '')
      })
      return { route, params }
    }
    return null
  }
}

/** SSE 客户端管理：任务进度 / 日志通过它推送到浏览器。 */
export class SseHub {
  private readonly clients = new Set<ServerResponse>()
  private readonly heartbeat: NodeJS.Timeout

  constructor() {
    this.heartbeat = setInterval(() => this.comment('ping'), 15_000)
    this.heartbeat.unref?.()
  }

  attach(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    res.write(': connected\n\n')
    this.clients.add(res)
    req.on('close', () => {
      this.clients.delete(res)
    })
  }

  broadcast(event: ServerEvent): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`
    for (const client of this.clients) {
      try {
        client.write(payload)
      } catch {
        this.clients.delete(client)
      }
    }
  }

  private comment(text: string): void {
    for (const client of this.clients) {
      try {
        client.write(`: ${text}\n\n`)
      } catch {
        this.clients.delete(client)
      }
    }
  }

  closeAll(): void {
    clearInterval(this.heartbeat)
    for (const client of this.clients) {
      try {
        client.end()
      } catch {
        // 忽略
      }
    }
    this.clients.clear()
  }
}

/** 读取 JSON body（限制 2MB，防止误传大文件）。 */
export function readJsonBody(req: IncomingMessage, limitBytes = 2 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new HttpError(413, '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined)
        return
      }
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'))
      }
    })
    req.on('error', (error) => reject(error))
  })
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

/** 恒定时间比较，避免 token 被计时攻击枚举。 */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a)
  const bufferB = Buffer.from(b)
  if (bufferA.length !== bufferB.length) return false
  return timingSafeEqual(bufferA, bufferB)
}

export function extractToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers[TOKEN_HEADER]
  if (typeof header === 'string' && header.length > 0) return header
  const query = url.searchParams.get(TOKEN_QUERY)
  return query && query.length > 0 ? query : null
}

export function createToken(): string {
  return randomBytes(24).toString('hex')
}
