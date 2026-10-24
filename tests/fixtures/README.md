# 测试样片目录

本目录用于本地手工验收，**样片文件不入库**（见根目录 `.gitignore`）。

建议放置：

- 一段 H.264/AAC 的 MP4（1080p，含音轨）
- 文件名含中文与空格的副本
- 一段 HEVC 或 VP9 的 MKV/WebM
- 一段高帧率（60/120fps）或竖屏素材

无样片时 `npm run test:integration` 会自动跳过并提示。
