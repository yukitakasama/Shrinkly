/// <reference types="vite/client" />
import type { ShrinklyBridge } from '../shared/bridge'

declare global {
  interface Window {
    /** 仅原生窗口存在；浏览器（`--web`）测试模式下为 undefined。 */
    shrinkly?: ShrinklyBridge
  }
}

export {}
