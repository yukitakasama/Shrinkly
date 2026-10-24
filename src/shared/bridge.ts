/** 原生窗口桥接 API（仅由 preload 暴露，浏览器模式下不存在）。 */
export interface ShrinklyBridge {
  /** Electron 提供：从拖拽的 File 对象拿到真实磁盘路径。 */
  getPathForFile: (file: unknown) => string
  pickFiles: () => Promise<string[]>
  pickDirectory: () => Promise<string | null>
  pickExecutable: () => Promise<string | null>
  reveal: (targetPath: string) => Promise<void>
}

/** IPC 通道名（主进程与 preload 共用，避免拼写不一致）。 */
export const NATIVE_CHANNELS = {
  pickFiles: 'shrinkly:pick-files',
  pickDirectory: 'shrinkly:pick-directory',
  pickExecutable: 'shrinkly:pick-executable',
  reveal: 'shrinkly:reveal'
} as const
