# Shrinkly — FFmpeg 视频转换与压缩工具 · 实施计划

> 状态：**已确认**（2026-10-24）。真实样片由用户通过 WebGUI 手工验收，不提交仓库。
> 目录：`D:\my-project\Shrinkly`（当前为空目录，尚未初始化 Git）
> 日期：2026-10-24

---

## 0. 需求确认结论（来自本轮问答）

| 决策项 | 结论 |
| --- | --- |
| 平台 / 界面 | Windows 优先；**Electron 外壳 + TypeScript/React WebGUI**，代码保持跨平台 |
| 格式范围 | 容器 **MP4 / MKV / WebM / MOV**；视频 **H.264 / HEVC / AV1 / VP9**；音频 AAC / Opus / MP3 / FLAC / 复制 |
| 输入输出 | 单文件为主 + **批量队列**、拖拽导入、输出目录与命名模板、冲突策略可选 |
| 压缩模型 | **0–100 质量滑块（0=极致压缩，100=近原画质，默认 60）** + 可选「目标体积(MB)」覆盖 |
| 分辨率 / 帧率 | 允许自动降分辨率（带下限保护）、允许自动降帧率（仅高帧率场景）、硬件加速可开关且失败自动回退 |
| 音频 | 默认 AAC 重编码 + 按档位智能码率；高声道降为立体声；提供高级选项（复制/移除/重编码） |
| FFmpeg | 优先使用用户自带（PATH / 自定义路径）；缺失时提供 **内置 winget 安装**（`Gyan.FFmpeg`）与手动指引 |
| 交付 | `npm run dev` 开发运行 + electron-builder **便携 exe + NSIS 安装包** |
| 测试 | 主要用**用户提供的真实样片**（`tests/fixtures/`，不提交仓库）+ 纯函数单元测试 |

已验证的本机环境：Windows 11 (26300)、Git Bash、ffmpeg/ffprobe 2026-07-02 gyan essentials（libx264 / libx265 / libvpx-vp9 / libaom-av1 / NVENC / QSV / AMF / d3d12va）、Node 24.15、npm 11.12、winget 1.29。**无 libsvtav1**，AV1 软件编码使用 `libaom-av1`（慢，默认 `cpu-used 6`）。

---

## 1. 需求清单

### 1.1 功能需求

| 编号 | 需求 | 验收要点 |
| --- | --- | --- |
| F1 | 一键 ffprobe 读取源信息 | 容器、时长、文件大小、视频编码/分辨率/帧率/码率/像素格式、音频编码/码率/声道/采样率；多音轨/封面图正确跳过 |
| F2 | 格式转换与压缩 | 支持四容器 + 四编码器组合；输出可播放、音画同步 |
| F3 | 高级模式 | 手动设置容器、编码器、码率/CRF、分辨率、帧率、预设、profile/level、像素格式、音频模式/码率/声道/采样率、额外参数 |
| F4 | 参数校验 | 非法数值、容器-编码器不兼容、输出扩展名与容器不符等，给出明确中文错误与修正建议 |
| F5 | 简易模式 | 导入后自动填充源参数；质量滑块/目标体积驱动自动计算；实时显示预计大小与 FFmpeg 命令摘要 |
| F6 | 计算规则可解释 | 界面展示「为何降分辨率/降帧率/取该码率」的推导说明；分辨率、帧率不高于源；码率有上下限 |
| F7 | 进度/日志/取消 | 百分比、速度、ETA、当前帧；实时日志（可搜索/导出）；单任务与全部取消；取消后清理半成品 |
| F8 | 结果反馈 | 成功/失败提示；输出路径（可打开所在文件夹）、文件大小、实际编码参数、压缩率、耗时 |
| F9 | 批量队列 | 多文件排序、逐条状态、并发上限可配（默认 1） |
| F10 | 拖拽导入 | 拖入文件/文件夹（递归扫描常见扩展名）即入队 |
| F11 | 输出规则 | 输出目录（源目录/指定目录）+ 命名模板 tokens；同名冲突策略：询问/自动重命名/覆盖/跳过（默认自动重命名） |
| F12 | 健壮性 | 路径含空格/中文、文件不存在/无权限、输出目录不可写、ffmpeg 缺失、编码中途失败、磁盘满 |

### 1.2 非功能需求

- **安全**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；渲染层仅通过 preload 暴露的白名单 IPC；禁用新窗口与外部导航；CSP 限制。
- **可维护**：主进程 / 预加载 / 渲染层 / 共享计算模块分层；参数计算为纯函数，可在 Node 与浏览器复用。
- **性能**：10 万条日志不卡 UI（虚拟列表或按批 flush）；ffprobe 单次调用 <200ms；滑块估算无阻塞（防抖 80ms）。
- **可回退**：小步提交、分支开发、提交清单与回退方法写入本文件。

### 1.3 明确不做（MVP 范围外）

- 视频剪辑/裁剪/合流/字幕烧录/滤镜链编辑器。
- HDR→SDR 色调映射（仅检测并告警，默认保持源色彩参数；不做 tonemap）。
- 网络串流输入、DRM、蓝光目录。
- 自动下载 ffmpeg（改为 winget 安装或手动指引；不捆绑二进制以规避许可与体积问题）。
- macOS/Linux 安装包（代码兼容，但仅验证 Windows）。

---

## 2. 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 桌面壳 | Electron 33+ | 主进程 Node 直接 spawn ffmpeg |
| 构建 | Vite 6 + electron-vite | 主/预加载/渲染三端统一构建 |
| UI | React 18 + TypeScript 5 | 函数组件 + hooks |
| 状态 | Zustand | 轻量、易持久化选择 |
| 样式 | 原生 CSS + CSS Variables（深色主题） | 避免额外构建链；少量自写组件 |
| 校验 | Zod | IPC 入参、表单、参数边界统一校验 |
| 单元测试 | Vitest | 纯函数与参数构造器 |
| 打包 | electron-builder | `portable` + `nsis` 目标 |
| 配置存储 | 自写 JSON（`app.getPath('userData')/settings.json`） | 原子写入，避免额外依赖 |
| 进程管理 | `child_process.spawn` + `taskkill /T /F` | 参数数组传递，不经过 shell |

依赖控制：运行时依赖仅 `zustand`、`zod`（可选 `electron-log` 由自写 logger 替代）。开发依赖：electron、electron-vite、vite、react、typescript、vitest、electron-builder、@types/*。

---

## 3. 模块划分

```
Shrinkly/
├─ PLAN.md
├─ README.md
├─ package.json
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ tsconfig.json / tsconfig.node.json / tsconfig.web.json
├─ .gitignore
├─ src/
│  ├─ main/
│  │  ├─ index.ts               # 应用生命周期、单实例锁、窗口
│  │  ├─ ipc/handlers.ts        # 白名单 IPC 注册（probe/estimate/start/cancel/...）
│  │  ├─ ffmpeg/
│  │  │  ├─ locator.ts          # PATH/自定义路径探测、版本校验、winget 安装
│  │  │  ├─ capabilities.ts     # 编码器/硬件加速能力探测与缓存
│  │  │  ├─ probe.ts            # ffprobe JSON 解析（含异常输入）
│  │  │  ├─ args.ts             # FFmpeg 参数构造（纯函数，可单测）
│  │  │  ├─ runner.ts           # spawn、-progress 解析、取消、超时、半成品清理
│  │  │  └─ errors.ts           # 错误分类 → 中文文案 + 建议
│  │  ├─ jobs/queue.ts          # 队列、并发控制、状态机
│  │  ├─ fs/paths.ts            # 输出模板、冲突策略、可写性探测、磁盘空间
│  │  ├─ settings.ts            # 配置读写（原子写入）
│  │  └─ logger.ts              # 文件日志（按大小轮转）+ 内存环形缓冲
│  ├─ preload/index.ts          # contextBridge 暴露类型化 API
│  ├─ shared/
│  │  ├─ types.ts               # MediaInfo / JobSpec / JobState / 校验结果
│  │  ├─ estimate.ts            # 码率/分辨率/帧率/音频计算（纯函数）
│  │  ├─ presets.ts             # 容器-编码器矩阵、质量档位、编码器能力表
│  │  └─ validation.ts          # Zod schema + 跨字段兼容性校验
│  └─ renderer/
│     ├─ index.html
│     ├─ main.tsx
│     ├─ App.tsx
│     ├─ store.ts
│     ├─ components/
│     │  ├─ DropZone.tsx        # 拖拽 + 文件选择
│     │  ├─ JobList.tsx         # 队列、进度、取消
│     │  ├─ InfoPanel.tsx       # ffprobe 源信息
│     │  ├─ SimpleMode.tsx      # 滑块 / 目标体积 / 估算卡 / 命令摘要
│     │  ├─ AdvancedMode.tsx    # 全部高级参数
│     │  ├─ ResultDialog.tsx    # 输出信息与打开目录
│     │  ├─ LogDrawer.tsx       # 日志搜索/导出
│     │  └─ FfmpegStatus.tsx    # 检测状态 / winget 安装 / 自定义路径
│     └─ styles/*.css
├─ tests/
│  ├─ unit/*.test.ts            # estimate / validation / args / paths
│  ├─ integration/run.mjs       # 需要本地样片，手动执行
│  └─ fixtures/                 # gitignored，仅保留 README.md
└─ build/                       # 图标等打包资源
```

**边界原则**：`shared/estimate.ts`、`shared/validation.ts`、`main/ffmpeg/args.ts` 不依赖 Electron，纯函数，Vitest 直接覆盖；渲染层调用 `estimate` 得到实时预览，主进程在真正启动任务前**再次**用同一函数计算，防止 UI 与执行不一致。

---

## 4. FFmpeg / ffprobe 调用方案

### 4.1 二进制定位（`locator.ts`）

1. 若设置中有自定义路径 → 校验可执行（`-version` 退出码 0）→ 使用。
2. 否则在 `PATH` 中查找 `ffmpeg` / `ffprobe`（Windows 注意 `ffmpeg.exe`）。
3. 均失败 → 状态 `missing`，UI 展示：
   - 首选按钮「用 winget 安装」：确认弹窗 → `winget install --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements`；流式输出日志；完成后刷新 PATH（读取注册表/重启进程环境变量）并重新探测；失败则展示手动指引。
   - 次选「选择 ffmpeg 路径」：文件对话框选 `ffmpeg.exe`，同目录推断 `ffprobe.exe`。
4. 版本与能力缓存到 `userData/ffmpeg-capabilities.json`（含 mtime 失效）。

### 4.2 ffprobe

```bash
ffprobe -v error -print_format json -show_format -show_streams -show_chapters "<input>"
```

解析要点：

- 时长优先级：`format.duration` → 视频流 `duration` → `nb_frames/fps`；缺失则 `null` 并禁用目标体积模式。
- 视频流：取 `codec_type=video` 且 **排除** `disposition.attached_pic=1`；帧率用 `avg_frame_rate`（回退 `r_frame_rate`，解析 `30000/1001`，异常时按 0 处理）。
- 多视频流：默认取第一路非封面流，高级模式可选择 `-map 0:v:N`。
- 音频：取第一路；记录全部音轨数量；`bit_rate` 缺失时用 `format.bit_rate - 视频码率` 估算，仍缺失则标记 `unknown`（估算按 128k）。
- 附加信息：`pix_fmt`、`color_space/transfer/primaries`（HDR 检测）、`codec_tag_string`、SAR/DAR、`field_order`（隔行提示）。
- 错误：非媒体文件 → `PROBE_UNSUPPORTED`；文件不存在 → `FILE_NOT_FOUND`；输出为空/超时（10s）→ `PROBE_FAILED`。

### 4.3 运行与进度

```bash
ffmpeg -hide_banner -nostdin -y \
  -i "<input>" \
  -map 0:v:0 -map 0:a? -map_metadata 0 -map_chapters 0 \
  <video args> <audio args> \
  -progress pipe:1 -nostats \
  -f mp4 "<output>.part"
```

- `spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore','pipe','pipe'] })`，**从不使用 `shell: true`**，空格/中文路径天然安全。
- 进度：读取 stdout 的 `key=value` 块（`out_time_us`、`frame`、`fps`、`speed`、`total_size`、`progress`），用「已处理时长 / 源时长」算百分比；`speed` 与剩余时长算 ETA；节流 4 次/秒推送 UI。
- 每任务同时保留 stderr 最近 200 行用于错误诊断，完整的写入任务日志文件。
- **取消**：Windows `taskkill /PID <pid> /T /F`；POSIX `process.kill(-pid, 'SIGKILL')`（detached 进程组）。取消后删除 `.part`，任务状态 `canceled`。
- **卡死检测**：连续 60s 无任何进度且进程存活 → 日志警告（不自动杀，避免误判慢编码）。
- **原子产出**：先写同目录 `<name>.part.<ext>`，成功后 `rename` 到最终名；失败/取消删除临时文件，绝不留下损坏的目标文件。
- **覆盖**：冲突策略在 rename 前判定，`overwrite` 时先写临时文件再替换，避免中途失败破坏原文件。

### 4.4 容器 / 编码器兼容矩阵（硬约束）

| 容器 | 视频 | 音频 | 备注 |
| --- | --- | --- | --- |
| MP4 | H.264 / HEVC / AV1 | AAC / MP3 / FLAC(实验) | HEVC 加 `-tag:v hvc1`；加 `-movflags +faststart`；不支持 Opus/Vorbis |
| MOV | H.264 / HEVC | AAC / MP3 | 同上；**实测 ffmpeg mov muxer 不支持 FLAC / AV1，故收窄**（见 §13 实施记录） |
| MKV | 全部 | 全部（含 Opus/FLAC） | 默认字幕/章节复制 |
| WebM | VP9 / AV1 | Opus / Vorbis | 禁止 H.264/HEVC/AAC；明确报错并建议换 MKV |

音频编码器映射：`aac` → `aac`；`opus` → `libopus`；`mp3` → `libmp3lame`；`flac` → `flac`；`copy` → `-c:a copy`（不兼容时报错）。

### 4.5 关键参数模板

- 视频：`-c:v <enc>`，H.264/HEVC 用 `-preset <p>`，VP9 用 `-row-mt 1 -cpu-used <n>`，AV1 用 `-cpu-used <n> -row-mt 1`；`-pix_fmt yuv420p`（源为 10bit 且编码器支持时可选 `yuv420p10le`）。
- 质量：`-crf <n>`（x264/x265/libvpx/libaom）；硬件用 `-rc vbr -cq <n> -b:v <cap>`。
- 码率：`-b:v <k> -maxrate <1.5k> -bufsize <2k>`；2-pass（可选）用 `-pass 1 -f null NUL` + `-pass 2`。
- 分辨率：`-vf scale=w:h:flags=lanczos`（保持 DAR、宽高取偶）。
- 帧率：`-r <fps> -fps_mode cfr`；不改帧率时不加 `-r`，避免无谓重采样。
- 音频：`-c:a aac -b:a <k> -ac <1|2> -ar <48000|源>`；`-c:a copy` 时禁止再带 `-b:a/-ac/-ar`。
- 同步：不加 `-shortest`；保留 `-map_metadata 0`；不裁时间线；`-avoid_negative_ts make_zero`（仅 MP4/MOV 且重编码时）。

---

## 5. 参数计算规则（可解释、可单测）

记 `q ∈ [0,100]`（默认 60），`W×H` 源分辨率，`fps` 源帧率，`D` 时长（秒），编码器 `E`。

### 5.1 质量档位与 CRF

| 编码器 | CRF 公式 | q=0 | q=60 | q=100 |
| --- | --- | --- | --- | --- |
| libx264 | `round(36 - 0.20q)` | 36 | 24 | 16 |
| libx265 | `round(34 - 0.19q)` | 34 | 23 | 15 |
| libvpx-vp9 | `round(40 - 0.24q)` | 40 | 26 | 16 |
| libaom-av1 | `round(42 - 0.26q)` | 42 | 26 | 16 |
| *nvenc/qsv/amf* | `-cq = CRF(x264) + 2`（硬编同画质需略高） | 38 | 26 | 18 |

界面上每个档位附一句人话解释：`q=60 → x264 CRF 24，1080p30 约 4–6 Mbps，肉眼几乎无损`。

### 5.2 码率估算（质量模式）

```
bpp(q) = 0.020 + 0.160 * (q/100)^1.6          // bits per pixel per frame, 基准 x264
eff    = { h264: 1.00, hevc: 0.65, vp9: 0.75, av1: 0.55 }
视频码率 ≈ W * H * fps * bpp(q) * eff[E]      // bit/s
预计大小 = (视频码率 + 音频码率) * D / 8 * 1.02  // 2% 容器开销
```

- 1080p30 / q=60 / h264：`1920*1080*30*0.0896 ≈ 5.6 Mbps`。
- 估算误差在 ±25% 内即视为合理，UI 明确标注「估算值，实际可能有差异」。
- 若源视频码率已知且估算值 > `2.0 × 源码率`，则封顶为 `2.0 × 源码率`（避免小体积源被“放大”）；除非用户选择更高画质且显式接受。

### 5.3 目标体积模式

```
总码率 = 目标MB * 8 * 1024 * 1024 / D * 0.97
视频码率 = 总码率 - 音频码率
```

可行性检查（不可行时给出最小可达体积，不静默降级）：

1. 若 `视频码率 < 绝对下限`（H.264 80 kbps / HEVC 60 kbps / AV1 50 kbps / VP9 60 kbps）→ 报错并给出 `最小可达 ≈ X MB`。
2. 若源分辨率所需最低码率仍高于目标 → 进入 5.4 降分辨率，直到满足或触达下限 360p。
3. 若仍需降帧率（5.5）→ 先降帧率再降分辨率，避免「小尺寸高帧率」的抖动。
4. 目标体积模式**强制单遍 ABR**（`-b:v/-maxrate/-bufsize`）；需要精确体积时高级模式可开 2-pass。

### 5.4 分辨率选择

```
候选高度 = [2160, 1440, 1080, 720, 480, 360]  // 不高于源高度
minBPP   = { h264: 0.050, hevc: 0.035, vp9: 0.040, av1: 0.028 }  // bit/px/frame
选择满足 视频码率 >= minBPP[E] * W' * H' * fps 的最大高度
```

- 宽度按 DAR 等比计算并取偶数；不足 2 像素的偏差回到高度。
- 下限：`min(360, 源高度)`；源本身低于 360 或竖屏短片（如 720×1280）时按短边判定档位，避免误降到 360×640 以下。
- 绝不上采样；源高不是标准档位时，取「不高于源高的最大候选」，若与源高差距 <10% 则保持源分辨率（避免无意义重采样）。

### 5.5 帧率

- 源 `fps ≤ 60`：**保持不变**。
- `fps > 60`：上限 60；若 `视频码率 / (目标分辨率下 60fps 所需最低码率) < 1.2` 则降到 30。
- 目标体积模式且码率极紧（`< 0.5 ×` 同分辨率 30fps 最低码率）时，可在降到 360p 后进一步降到 30/24fps。
- 只降不升；帧率变化时使用 `-fps_mode cfr`，音频不做任何裁切，保证音画同步。

### 5.6 音频

| q 区间 | AAC 码率 | Opus 码率 |
| --- | --- | --- |
| 0–19 | 64k | 48k |
| 20–39 | 96k | 64k |
| 40–59 | 128k | 96k |
| 60–79 | 160k | 128k |
| 80–100 | 192k | 160k |

- 源音频码率 `< 目标 × 1.1` 时取 `min(目标, 源)` 并对齐到 8k，避免无意义膨胀。
- 声道：`>2` 声道 → 降为 2（`-ac 2`），并在 UI 说明；单声道保持单声道。
- 采样率：源 `> 48kHz` → 48k；否则保持源。
- 无音轨：自动 `-an`，不报错。
- 高级模式可选 `copy` / `remove` / 指定码率，选择后跳过上述自动规则并重新校验兼容性。

### 5.7 硬编策略

- 开启后按 `h264_nvenc → h264_qsv → h264_amf` 顺序探测（用极短 lavfi 测试编码，结果缓存）。
- 硬编失败（stderr 含 `Cannot load`、`No capable devices`、`InitializeEncoder failed` 等）→ 自动用软件编码重跑一次，日志标注 `[hw-fallback]`，任务结果中显示实际使用的编码器。
- 硬编模式下仍保留 `-b:v` 上限，防止 CQ 模式码率失控。

### 5.8 校验规则（示例）

- 尺寸：`16 ≤ w,h ≤ 8192`，必须为偶数；宽高比偏差 >5% 提示。
- 码率：`50k ≤ b:v ≤ 80000k`，且不超过编码器/级别上限（超限提示改用 CRF 或更高 profile）。
- CRF：x264/x265 `0–51`；VP9 `0–63`；AV1 `0–63`；超出范围直接拒绝。
- 帧率：`1–120`；`>120` 拒绝。
- 输出扩展名与容器不一致 → 自动纠正并提示，或阻止启动（默认阻止 + 一键修正）。
- 源路径 == 输出路径 → 强制改名为 `{name}_1.ext`，绝不原地覆盖源文件。
- WebM + H.264/AAC → 明确错误：`WebM 仅支持 VP9/AV1 + Opus/Vorbis，请改用 MKV 或 MP4`。
- 附加参数框：禁止 `-i`、`-f`、输出路径类参数（防止破坏我们的参数结构），仅允许白名单前缀；出现可疑参数时高亮警告。

---

## 6. 简易模式与高级模式交互

### 6.1 界面结构

```
┌──────────────────────────────────────────────────────────────┐
│ Shrinkly        [FFmpeg: OK v2026-07-02 ▾]        [设置]      │
├──────────────┬───────────────────────────────────────────────┤
│ 队列 (拖拽区)│  简易模式 | 高级模式                            │
│ ┌──────────┐ │  ┌── 源信息 ────────────────────────────────┐  │
│ │ file.mp4 │ │  │ MP4 · 00:03:12 · 248MB · H.264 1080p30   │  │
│ │ 62% ▓▓▓  │ │  │ AAC 128k 2ch 48k                         │  │
│ └──────────┘ │  └──────────────────────────────────────────┘  │
│ ...          │  质量 [0───●────100]  均衡 (60)                │
│              │  □ 指定目标大小  [ 50 ] MB                      │
│              │  ┌ 预计输出 ───────────────────────────────┐   │
│              │  │ ≈ 42.3 MB (↓83%) · 1080p30 · 4.8Mbps    │   │
│              │  │ 说明: 码率 4.8Mbps 足以支撑 1080p30…    │   │
│              │  └─────────────────────────────────────────┘   │
│              │  ▸ 将执行: ffmpeg -i … -crf 24 … (可复制)      │
│              │  [开始转换]                                     │
├──────────────┴───────────────────────────────────────────────┤
│ 日志 ▾  搜索…  [导出]                                        │
└──────────────────────────────────────────────────────────────┘
```

### 6.2 简易模式

- 导入后自动回填：源容器、编码、分辨率、帧率、码率、音频信息。
- 默认输出：容器 = 源容器（源为不支持的容器则 MP4）；编码器 = 源编码对应软件编码器（H.264→libx264，HEVC→libx265，AV1→libaom-av1，VP9→libvpx-vp9；其它→libx264）；音频 AAC。
- 滑块：0/20/40/60/80/100 有刻度与标签（极致压缩 / 高压缩 / 均衡 / 高清 / 近原画质），默认 60；键盘 ←/→ 微调 1，Shift+←/→ 微调 10。
- 目标体积开关：打开后滑块变为「按目标体积求解」，仍显示等效质量档位。
- 实时更新（防抖 80ms）：预计大小、压缩率、目标分辨率/帧率、视频/音频码率、实际使用的编码器、命令摘要、可解释文字。
- 变更立即反映到命令摘要；命令摘要只读 + 一键复制（自动脱敏为相对路径不影响可读性）。

### 6.3 高级模式

折叠分组，默认值来自简易模式计算结果，切换模式不丢参数：

1. **容器**：MP4/MKV/WebM/MOV + 兼容性实时提示。
2. **视频**：编码器、码率控制（CRF / ABR / 2-pass ABR）、CRF 值、码率、分辨率（源 / 自动 / 预设 / 自定义）、帧率（源 / 自动 / 自定义）、预设（ultrafast…veryslow，硬编映射 p1–p7）、profile/level、像素格式、GOP、B 帧、硬件加速开关。
3. **音频**：模式（AAC 重编码 / 复制 / 移除）、码率、声道、采样率。
4. **输出**：目录、命名模板、冲突策略、是否保留元数据/章节/字幕（MKV 可复制字幕）。
5. **额外参数**：白名单校验 + 警告。
6. **命令预览**：完整命令，含 `-progress` 前的可执行部分（可复制）。

「重置为自动」按钮把高级项恢复为由源参数 + 滑块推导的值。

---

## 7. 错误处理

| 场景 | 检测点 | 处理 |
| --- | --- | --- |
| 文件不存在 / 不可读 | 入队前 + 启动前 | 队列项标红，提示具体路径；不加入执行 |
| 非视频/损坏文件 | ffprobe 失败 | `无法识别媒体信息`：显示 ffprobe 摘要末 5 行；建议检查文件 |
| 输出目录不存在 | 启动前 | 自动创建（可关）；创建失败 → `输出目录不可写`，提示换目录 |
| 输出目录只读/权限不足 | 写测试文件 | 明确提示并给出「以当前用户可写的目录」建议 |
| 磁盘空间不足 | 估算大小 vs 可用空间 | 启动前警告；不足则阻断（允许强制继续） |
| FFmpeg 缺失 | 启动时探测 | 顶部状态条 + 安装卡片；所有任务按钮禁用并说明原因 |
| 编码器不存在 | 能力探测 | 禁用该选项；若用户手填则启动前报错 |
| 硬编初始化失败 | stderr 匹配 | 自动回退软件编码一次，日志标注，不打断任务 |
| 编码中途失败 | 退出码 ≠ 0 | 失败卡片显示：退出码、错误分类、最后 20 行 stderr、建议（如换编码器/降分辨率） |
| 取消 | 用户操作 | 杀进程树 → 删 `.part` → 状态 `已取消`，不弹错误 |
| 半成品/残留 | 启动时扫描 | 仅清理本应用命名规则的 `*.part.*`（超过 1 天），不误删用户文件 |
| 路径含空格/中文/emoji | 全程 | 参数数组传递，日志用引号包裹展示；集成测试覆盖 |
| 同名冲突 | rename 前 | 按策略处理；`覆盖` 也是先写临时文件 |
| 输出与源同路径 | 启动前 | 强制改后缀/加序号，提示用户 |

错误对象统一结构：`{ code, title, detail, hint, raw? }`，渲染层只负责展示，便于后续国际化。

---

## 8. 测试计划

### 8.1 单元测试（Vitest，不依赖 ffmpeg）

- `estimate`：滑块单调性（q↑ → 码率↑、CRF↓）；分辨率下限保护；竖屏/超宽屏取档；目标体积反解；极小目标不可行报错；音频码率不高于源。
- `validation`：容器-编码器矩阵全组合；边界值（0/51/63/8192/奇数尺寸）；输出扩展名冲突。
- `args`：给定 JobSpec 生成参数快照；`copy` 音频不携带 `-b:a`；WebM 拒绝 H.264；`faststart` 只在 MP4/MOV；中文路径不被转义。
- `paths`：命名模板 tokens、同名冲突四策略、非法字符清理（Windows `<>:"/\|?*`）。

### 8.2 集成测试（可选，样片由用户自行准备，`tests/fixtures/`）

> 已确认：真实样片不入库，验收以用户在本机 WebGUI 手工测试为主。集成脚本保留为可选工具，`tests/fixtures/` 为空时自动跳过并提示。

可参考放入（任一即可，建议 3 段 10–60s）：

1. H.264/AAC 的 MP4（1080p，含中文与空格文件名各一份）；
2. HEVC 或 VP9 的 MKV/WebM（验证跨容器）；
3. 高帧率（60/120fps）或竖屏短视频（验证帧率/竖屏取档）。

脚本 `npm run test:integration` 断言：

- 输出存在、`ffprobe` 可读、时长误差 ≤ 0.5s（含音轨时）；
- 分辨率/帧率不高于源，容器与扩展名一致；
- 目标体积模式误差 ≤ ±12%；
- 完整解码检查：`ffmpeg -v error -i out -f null -` 无输出（无解码错误）；
- 路径含中文/空格场景正常产出；
- 取消后无残留 `.part` 文件。

### 8.3 手工验收清单

- 拖拽 1 个/多个文件、拖入文件夹；
- 简易模式滑块实时变化 + 命令摘要更新；
- 高级模式非法参数逐项报错（码率超限、CRF 越界、WebM+H.264）；
- 转换中取消 → 状态正确、临时文件清理；
- 断网/无 ffmpeg 的模拟（临时改 PATH）→ 安装卡片与指引；
- 成功卡片：路径、大小、实际参数、打开文件夹；
- 日志搜索/导出；
- 打包后的便携 exe 与安装包各跑一次完整流程。

---

## 9. Git 工作流

### 9.1 初始化与分支

```bash
git init -b main
git add .gitignore PLAN.md
git commit -m "docs: add implementation plan and ignore rules"
git switch -c feat/mvp-converter
```

- `main` 保持可交付；功能开发在 `feat/mvp-converter`；完成后 `--no-ff` 合并并打 `v0.1.0` 标签。
- 提交信息：Conventional Commits（`feat:` / `fix:` / `test:` / `docs:` / `chore:`），每步可独立回退。

### 9.2 计划提交序列（每步均可运行/回退）

| # | 提交信息 | 内容 |
| --- | --- | --- |
| 1 | `chore: init electron-vite + react + ts project` | 脚手架、tsconfig、eslint/prettier（可选）、能启动空窗口 |
| 2 | `feat(shared): add media types, presets and quality mapping` | 类型、容器矩阵、CRF/码率公式 |
| 3 | `feat(shared): add estimate and validation with unit tests` | 估算、校验 + Vitest |
| 4 | `feat(main): probe media and locate ffmpeg` | ffprobe 解析、定位、能力探测 |
| 5 | `feat(main): build ffmpeg args, run jobs with progress and cancel` | args/runner/queue/`.part` |
| 6 | `feat(ui): implement simple mode with live estimate` | 拖拽、信息卡、滑块、命令摘要 |
| 7 | `feat(ui): add advanced mode, queue, logs and results` | 高级参数、日志抽屉、结果卡 |
| 8 | `feat(main): winget install flow and settings persistence` | 缺失 ffmpeg 安装、配置 |
| 9 | `test: add integration script and manual checklist` | 集成脚本 + README 测试步骤 |
| 10 | `build: add electron-builder portable and nsis targets` | 打包配置、图标 |
| 11 | `docs: add README with usage, dependencies and limitations` | 运行/打包/已知限制 |
| 12 | `chore(release): v0.1.0` | 合并 main + tag |

### 9.3 .gitignore 关键项

```
node_modules/
dist/ out/ release/ build/*.exe
*.log
tests/fixtures/*
!tests/fixtures/README.md
*.mp4 *.mkv *.webm *.mov *.part.*
.DS_Store
Thumbs.db
.env
```

### 9.4 回退方法（写入 README 与本节）

- 回退单个提交：`git revert <hash>`（推荐，保留历史）。
- 回到某个里程碑：`git switch main && git reset --hard <hash>`（仅本地、确认无未提交改动）。
- 整条功能分支废弃：`git switch main && git branch -D feat/mvp-converter`。
- 发布回退：`git switch main && git reset --hard v0.1.0`。

---

## 10. 验收标准

**功能**
1. 导入 MP4/MKV/WebM/MOV 源文件，5 秒内展示全部要求字段（容器、时长、大小、编码、分辨率、帧率、码率、像素格式、音频编码/码率/声道/采样率）。
2. 简易模式拖动滑块，估算大小/分辨率/帧率/码率与命令摘要 200ms 内更新，且与最终执行参数一致。
3. 四个容器 × 四个编码器所有合法组合能产出可完整解码的文件；非法组合被阻止并给出明确中文说明。
4. 目标体积模式在 ±12% 内达成（10–60s 样片）；不可达时给出最小可达体积而非静默失败。
5. 批量队列可添加 ≥5 个文件，顺序执行，单独取消与全部取消均有效，无残留临时文件。
6. 输出命名模板与四种冲突策略生效；中文/空格路径全流程正常。
7. FFmpeg 缺失时按钮禁用并展示 winget 安装入口；模拟安装失败时展示明确手动指引。
8. 完成卡片显示输出路径、实际大小、实际编码器/分辨率/帧率/码率、压缩率与耗时。

**质量**
9. `npm run test` 全绿（单元测试 ≥25 条，覆盖估算/校验/参数构造/命名）。
10. 集成脚本在提供样片后全绿。
11. `npm run build:win` 产出便携 exe 与 NSIS 安装包，在干净目录双击可启动。
12. TypeScript `strict` 无错误；无 `any` 逃逸到 IPC 边界。

**工程**
13. Git 历史符合第 9.2 的提交序列，`main` 可构建，`v0.1.0` 标签存在。
14. 仓库中无视频、临时产物、`node_modules`、日志。
15. README 包含依赖安装、运行、测试、打包、关键提交与回退方法、已知限制。

---

## 11. 风险与已知限制

- **估算精度**：码率模型基于经验 bpp，动画/静态画面/高噪点素材误差可能达 ±30%；UI 始终标注估算性质，目标体积模式用 ABR 收敛到 ±12%。
- **AV1 软件编码极慢**（libaom，无 SVT-AV1）：默认 `cpu-used 6`，长视频提示耗时；建议优先硬编 AV1（NVENC/QSV/AMF）或改用 HEVC。
- **HDR**：MVP 不处理 HDR→SDR 映射，HDR 源保持原色彩标记并在 UI 警告「可能偏色」；需要时应显式关闭自动色彩参数。
- **VFR 源**：改帧率时转 CFR，可能轻微改变时间轴；不改帧率时保留原时间戳。
- **硬件编码质量**：同 CRF 下硬编画质略低，UI 说明并允许一键切回软件编码。
- **Windows 中文路径**：Node spawn 参数数组可正确处理，但部分杀毒软件会拦截子进程写入；已在错误提示中给出排查建议。
- **winget 安装**依赖网络与用户权限，失败时仅提供手动指引，不自动下载二进制。

---

## 12. 确认记录（2026-10-24）

1. 计划整体方向已认可：估算公式、默认 q=60、默认输出 `{name}_compressed.{ext}`。
2. 真实样片由用户在本机 WebGUI 手工测试，不提供固定 fixture；`tests/fixtures/` 仅保留占位说明，集成脚本在无样片时跳过。
3. 应用名 **Shrinkly**、界面**简体中文**、**深色主题**。

执行顺序：初始化 Git → 提交本计划 → 创建 `feat/mvp-converter` 分支 → 按第 9.2 顺序实现并逐步提交。

---

## 13. 实施记录（2026-10-24）

> **交付形态变更（本次需求，已实施）**：用户明确要求「不要原生界面，双击 exe 在浏览器里用 WebGUI」。
> 因此「拖拽导入」改为服务端文件浏览器选择；界面从 Electron 渲染层改为浏览器页面；
> 业务逻辑下沉为**不依赖 Electron 的本地 HTTP 服务**（`src/server`），Electron 仅保留为无窗口托盘外壳与打包载体（`src/main/index.ts`）。
> 新增 token 鉴权 + 仅监听 127.0.0.1 + Host 校验 + CSP。对应版本 `v0.2.0`。

- **已完成**：§9.2 的 1–12 全部落地，`feat/mvp-converter` 以 `--no-ff` 合并回 `main` 并打 `v0.1.0` 标签。
- **单元测试**：126 条全绿（estimate / validation / args / paths / probe / capabilities）。
- **集成测试**：合成样片上 13 项全绿（含目标体积 ±12%、中文空格路径、取消后无 `.part` 残留）。
- **容器矩阵实测修正**：MOV 实际只支持 H.264 / HEVC + AAC / MP3；FLAC 仅 MP4 / MKV 可用；AV1 仅 MP4 / MKV / WebM 可用。
- **打包**：`npm run build:win` 产出便携版与 NSIS 安装包；因普通用户无法创建符号链接，默认关闭 rcedit（`build:win:iconed` 需管理员/开发者模式）。
- **文档**：新增 `README.md`、`docs/manual-checklist.md`、`docs/screenshots/overview.png`。

> **交付形态回退（2026-10-24 21:30）**：用户反馈浏览器 WebGUI 的观感与交互不如原生窗口，
> 决定**恢复 Electron 原生窗口**为默认形态，并保留 WebUI 作为前端自动化测试入口。
> 实现方式：界面仍是同一份 React + 本地 HTTP（REST + SSE），原生窗口直接加载 `http://127.0.0.1:<port>/?token=…`；
> preload 仅暴露拖拽取路径 / 系统文件目录对话框 / 资源管理器定位；`--web` / `SHRINKLY_WEB=1` 进入浏览器测试模式
> （`SHRINKLY_NO_BROWSER=1` 只启动服务）。窗口模式不做 GPU 禁用，恢复原生渲染性能。
