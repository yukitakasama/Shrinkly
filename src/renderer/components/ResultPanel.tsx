import { api } from '../lib/api'
import { selectedJob, useAppStore } from '../store'
import { formatBitrate, formatBytes, formatFps, formatRatio } from '../lib/format'

/** 结果与失败详情（PLAN F8）。 */
export default function ResultPanel(): React.JSX.Element | null {
  const job = useAppStore((state) => selectedJob(state))
  const setToast = useAppStore((state) => state.setToast)
  if (!job) return null

  const openFolder = async (): Promise<void> => {
    if (!job.result?.outputPath) return
    try {
      // 原生窗口优先用系统资源管理器定位；浏览器测试模式退回本地服务。
      if (window.shrinkly) await window.shrinkly.reveal(job.result.outputPath)
      else await api.reveal(job.result.outputPath)
    } catch (error) {
      setToast({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  if (job.status === 'done' && job.result) {
    const result = job.result
    return (
      <section className="card result-panel">
        <h3>转换完成</h3>
        <div className="result-path" title={result.outputPath}>
          {result.outputPath}
        </div>
        <div className="result-facts">
          <span>
            体积 {formatBytes(result.sizeBytes)}（{formatRatio(result.ratio)}）
          </span>
          <span>耗时 {(result.elapsedMs / 1000).toFixed(1)} 秒</span>
          <span>
            {result.width ?? '—'}×{result.height ?? '—'}
          </span>
          <span>{formatFps(result.frameRate)}</span>
          <span>视频 {formatBitrate(result.videoBitrateKbps)}</span>
          <span>音频 {result.audioBitrateKbps ? formatBitrate(result.audioBitrateKbps) : '无'}</span>
          <span className="tag">{result.encoder}</span>
          {result.hwFallback && <span className="tag warn">已回退软件编码</span>}
        </div>
        {result.hwFallback && (
          <p className="inline-note">
            GPU 加速失败，已自动改用 CPU 完成转换。原因：{result.hwFallbackReason ?? '硬件编码器初始化失败'}
          </p>
        )}
        <div className="actions">
          <button type="button" className="primary" onClick={() => void openFolder()}>
            打开所在文件夹
          </button>
        </div>
      </section>
    )
  }

  if (job.status === 'failed' && job.error) {
    return (
      <section className="card result-panel is-error">
        <h3>{job.error.title}</h3>
        <p>{job.error.detail}</p>
        <p className="hint">{job.error.hint}</p>
        {job.error.raw && (
          <details className="raw-block">
            <summary>查看 ffmpeg 原始输出（最后 20 行）</summary>
            <pre>{job.error.raw}</pre>
          </details>
        )}
      </section>
    )
  }

  const container = job.estimate?.container?.toUpperCase() ?? ''
  const source = job.media ? `${job.media.fileName}${container ? ` → ${container}` : ''}` : job.fileName

  if (job.status === 'skipped') {
    return (
      <section className="card result-panel is-muted">
        <h3>已跳过</h3>
        <p>{source} 的输出文件已存在，按「跳过」策略没有执行转换。</p>
        <p className="hint">可在高级模式的「同名冲突」里改为「自动重命名」或「覆盖」，再重新开始。</p>
      </section>
    )
  }

  if (job.status === 'canceled') {
    return (
      <section className="card result-panel is-muted">
        <h3>已取消</h3>
        <p>{source} 的任务已取消，未完成的临时文件已清理。</p>
        <p className="hint">修改参数后可直接重新点「开始压缩」。</p>
      </section>
    )
  }

  return null
}
