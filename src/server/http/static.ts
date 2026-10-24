/**
 * 静态资源服务：托管构建后的 WebGUI（`out/renderer`）。
 *
 * - 只允许访问 webRoot 目录内的文件（防目录穿越）；
 * - 找不到文件且路径无扩展名时回退到 index.html（SPA）；
 * - 附带基础安全响应头。
 */
import { readFile, stat } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  // WebGUI 与 API 同源；CSP 限制脚本来源，防止外部注入
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"
}

export async function serveStatic(webRoot: string, pathname: string, res: ServerResponse): Promise<boolean> {
  const decoded = decodeURIComponent(pathname)
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const target = resolve(join(webRoot, relative))
  const rootWithSep = resolve(webRoot) + sep
  if (target !== resolve(webRoot) && !target.startsWith(rootWithSep)) {
    return false
  }

  const trySend = async (filePath: string): Promise<boolean> => {
    try {
      const info = await stat(filePath)
      if (!info.isFile()) return false
      const body = await readFile(filePath)
      res.writeHead(200, {
        'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': extname(filePath) === '.html' ? 'no-store' : 'public, max-age=3600',
        ...SECURITY_HEADERS
      })
      res.end(body)
      return true
    } catch {
      return false
    }
  }

  if (await trySend(target)) return true
  // SPA 回退
  if (!extname(target)) return trySend(join(webRoot, 'index.html'))
  return false
}

export function sendNotFound(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS })
  res.end('Not Found')
}
