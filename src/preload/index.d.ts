import type { ShrinklyApi } from './index'

declare global {
  interface Window {
    shrinkly: ShrinklyApi
  }
}

export {}
