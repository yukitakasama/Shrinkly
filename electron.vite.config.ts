import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

/**
 * 开发模式下 React Refresh 需要注入内联脚本，会与严格的 CSP meta 冲突；
 * 这里只在 dev 放宽 script-src / connect-src，生产构建保持严格策略。
 */
function devCspPlugin(): Plugin {
  return {
    name: 'shrinkly-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      const devPolicy =
        "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'none'; form-action 'none'"
      return html.replace(
        /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/i,
        `$1${devPolicy}$2`
      )
    }
  }
}

/** 开发模式下浏览器访问 vite dev server，API 通过代理转发到本地服务。 */
const devApiPort = process.env['SHRINKLY_API_PORT'] ?? '12800'

export default defineConfig({
  // 主进程：本地 HTTP 服务 + 托盘外壳（无原生窗口），依赖全部打进 bundle。
  main: {
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), devCspPlugin()],
    server: {
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${devApiPort}`,
          changeOrigin: false,
          ws: false
        }
      }
    },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
})
