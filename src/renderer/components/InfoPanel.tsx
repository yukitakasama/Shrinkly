import { useAppStore, selectedJob } from '../store'
import { formatBitrate, formatBytes, formatDuration, formatFps } from '../lib/format'
import type { MediaInfo, MediaVideoStream } from '../../shared/types'

/** ffprobe 的 format_name 常见为 「mov,mp4,m4a,…」，这里映射成用户熟悉的容器名。 */
function containerLabel(media: MediaInfo): string {
  const name = (media.container ?? '').toLowerCase()
  if (name.includes('webm')) return 'WebM'
  if (name.includes('matroska')) return 'MKV'
  if (name.includes('mp4')) return 'MP4'
  if (name.includes('mov')) return 'MOV'
  return name.split(',')[0].toUpperCase() || '未知'
}

/** 编码名 + 长名（去掉重复的短名，例如 H264 与 H.264 视为相同）。 */
function codecLabel(video: MediaVideoStream): string {
  const short = video.codec.toUpperCase().replace('.', '')
  const long = video.codecLongName?.split(' / ')[0] ?? ''
  if (!long) return video.codec.toUpperCase()
  return long.toUpperCase().replace('.', '') === short ? video.codec.toUpperCase() : `${video.codec.toUpperCase()}（${long}）`
}

/** 源文件信息卡（ffprobe 结果）。 */
export default function InfoPanel(): React.JSX.Element {
  const job = useAppStore((state) => selectedJob(state))
  const media = job?.media ?? null

  if (!media) {
    return (
      <section className="card info-panel">
        <h3>源信息</h3>
        <p className="empty-hint">选择左侧任务以查看源文件信息。</p>
      </section>
    )
  }

  const video = media.video
  const audio = media.audio

  return (
    <section className="card info-panel">
      <h3>源信息</h3>
      <div className="info-title" title={media.path}>
        {media.fileName}
      </div>
      <div className="info-summary">
        <span>{containerLabel(media)}</span>
        <span>{formatDuration(media.durationSec)}</span>
        <span>{formatBytes(media.sizeBytes)}</span>
        {video && (
          <span>
            {video.codec.toUpperCase()} {Math.min(video.width, video.height)}p
          </span>
        )}
      </div>
      <dl className="info-grid">
        {video && (
          <>
            <dt>视频</dt>
            <dd>{codecLabel(video)}</dd>
            <dt>分辨率</dt>
            <dd>
              {video.width}×{video.height}
              {video.dar ? ` · DAR ${video.dar}` : ''}
            </dd>
            <dt>帧率</dt>
            <dd>{formatFps(video.frameRate)}</dd>
            <dt>视频码率</dt>
            <dd>{formatBitrate(video.bitRate ? video.bitRate / 1000 : null)}</dd>
            <dt>像素格式</dt>
            <dd>{video.pixelFormat ?? '—'}</dd>
          </>
        )}
        {audio ? (
          <>
            <dt>音频</dt>
            <dd>
              {(audio.codec ?? '未知').toUpperCase()} · {formatBitrate(audio.bitRate ? audio.bitRate / 1000 : null)}
            </dd>
            <dt>声道 / 采样率</dt>
            <dd>
              {audio.channels ?? '—'} 声道 · {audio.sampleRate ? `${audio.sampleRate} Hz` : '—'}
            </dd>
            <dt>音轨数</dt>
            <dd>{media.audioStreamCount}</dd>
          </>
        ) : (
          <>
            <dt>音频</dt>
            <dd>无音轨</dd>
          </>
        )}
      </dl>
      {media.warnings.length > 0 && (
        <ul className="warning-list">
          {media.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </section>
  )
}
