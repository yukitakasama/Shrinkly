/// <reference types="vite/client" />

import type { ShrinklyApi } from '../shared/ipc'

declare global {
  interface Window {
    shrinkly: ShrinklyApi
  }
}

export {}
