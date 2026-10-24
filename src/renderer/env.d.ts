/// <reference types="vite/client" />

import type { ShrinklyApi } from '../preload/index'

declare global {
  interface Window {
    shrinkly: ShrinklyApi
  }
}

export {}
