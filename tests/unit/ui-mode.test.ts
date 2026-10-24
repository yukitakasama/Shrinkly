import { describe, expect, it } from 'vitest'
import { resolveUiMode } from '../../src/main/ui-mode'

describe('UI 模式选择', () => {
  it('默认打开原生窗口', () => {
    expect(resolveUiMode([], {})).toBe('window')
    expect(resolveUiMode(['--no-sandbox'], {})).toBe('window')
  })

  it('--web / -w 打开浏览器测试模式', () => {
    expect(resolveUiMode(['--web'], {})).toBe('web')
    expect(resolveUiMode(['-w'], {})).toBe('web')
    expect(resolveUiMode(['--web', '--no-sandbox'], {})).toBe('web')
  })

  it('SHRINKLY_WEB=1 / true 也进入浏览器测试模式', () => {
    expect(resolveUiMode([], { SHRINKLY_WEB: '1' })).toBe('web')
    expect(resolveUiMode([], { SHRINKLY_WEB: 'true' })).toBe('web')
  })

  it('其他取值不影响默认行为', () => {
    expect(resolveUiMode([], { SHRINKLY_WEB: '0' })).toBe('window')
    expect(resolveUiMode([], { SHRINKLY_WEB: '' })).toBe('window')
  })
})
