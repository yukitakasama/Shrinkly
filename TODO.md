# TODO / 待办与未完成项

> 生成时间：2026-10-24 19:10（v0.2.0 浏览器 WebGUI 改造之后）
> 最近更新：2026-10-24 21:30（恢复原生窗口；WebUI 仅保留为测试入口）
> 约定：本文件记录**尚未验证 / 尚未完成**的事项，完成一项就勾掉并注明验证方式。

## 一、发布前必须人工确认（我这边环境无法替代）

- [x] **双击便携 exe 是否能用系统默认浏览器打开 WebGUI**
  - 已定位根因（2026-10-24 19:30）：本机 Windows 11 的实际默认浏览器由
    `HKCU\...\UrlAssociations\http\UserChoiceLatest\ProgId` 决定，值为
    `egoliteHTM.ZRYBLMXXW22RBVRYOTDTCEXMVI`（ego lite），旧的 `UserChoice`
    里仍写着 `ChromeHTML`，两者不一致容易误判。ego lite 冷启动/空间切换较慢，
    旧逻辑「4s + 5s + 5s」超时后就会打印「浏览器似乎没有打开」，并可能连开多个标签页。
  - 修复：把打开逻辑抽到 `src/main/browser.ts`，主等待放宽到 8s、只回退一次
    （rundll32 → cmd，且命令本身失败才继续）、回退后再等 15s；日志会打印每一步
    与耗时，失败提示改为「托盘复制访问地址 / runtime.json」。新增
    `tests/unit/browser.test.ts`（11 个用例）覆盖成功、静默失效、抛错、超时、
    去重与 `SHRINKLY_NO_BROWSER=1`。
  - 验证方式：重新构建后用同一份 `out/main` 启动，日志
    `请求系统默认浏览器打开 … → 浏览器已加载 WebGUI 页面 → 已用系统默认浏览器打开 WebGUI（322ms）`；
    重新打包的 portable exe 用 `SHRINKLY_NO_BROWSER=1` 启动，`/` 与 `/api/status` 均 200，
    页面在独立 ego space 中渲染正常。
  - 注意：本机自动打开会进入 ego lite（默认浏览器），属于系统行为。
- [ ] **托盘图标与菜单**（打开界面 / 复制访问地址 / 打开日志目录 / 退出 Shrinkly）在打包环境中逐项点一遍。
- [ ] **重复双击 exe**：不应启动第二个服务，而应把已有地址重新在浏览器打开。
- [ ] **NSIS 安装包**安装后从开始菜单启动，走一遍完整流程。

## 二、前端交互测试（在独立 ego space 中进行，不在用户 space 开标签页）

- [x] 导入文件（服务端文件浏览器 → 选中 → 导入所选）
- [x] 简易模式质量滑块变化 → 估算/命令摘要更新
- [x] 目标体积开关与不可达提示
- [x] 切换高级模式 → 容器/编码选择与兼容性提示
- [x] 开始转换 → 完成卡片（体积/参数/压缩率/耗时）
- [x] 日志抽屉：展开、搜索、级别过滤
- [x] 设置面板：字段读取与修改
- [x] 多文件批量导入与「全部取消」
  - 验证：在 `%TEMP%\opencode\shrinkly-fx\样片 目录\` 放 3 份同名样片，文件浏览器多选导入 → 「3 个任务」；
    点「全部取消」后 3 项全部变为「已取消」。「粘贴路径」多行导入同样可用。
- [x] 高级模式「重置为自动」与额外参数非法值提示
  - 验证：改 CRF 24→30 后标签变「手动参数」、命令摘要同步；「重置为自动」恢复 CRF 24。
  - 额外参数填 `-i foo.mp4`：现在会同时提示「不能包含 -i」与「不能包含文件名」，且「开始转换」禁用。
  - 期间修掉 3 个真实 bug：① `/api/validate` 对 schema 错误直接 400，界面看不到逐项错误；
    ② 额外参数在校验前就被过滤，错误被吞；③ 生成命令失败会把刚算出的校验结果一起吞掉。
- [x] 命名模板非法占位符提示
  - 验证：`{name}_{bogus}.{ext}` → 「未知的命名占位符 {bogus}」，开始按钮禁用。
- [x] 同名冲突四种策略的实际效果
  - 验证（在设置里改默认冲突策略后逐个导入，队列已启动会自动开跑）：
    自动重命名 → `sample C_compressed_7.mp4`；覆盖 → 覆盖写回 `sample C_compressed.mp4`；
    跳过 → 任务状态「已跳过」且不产出文件；询问 → 批量场景按自动重命名处理 → `_8.mp4`。
- [x] 目标体积 ±12% 精度在真实样片上的复核
  - 验证：`sample C.mp4`（4.6 MB / 5s）设目标 3 MB → 实际 3,066,445 字节，误差 −2.5%（相对 3 MiB），在 ±12% 内。
- [x] 中文/空格路径在 WebGUI 全流程中的表现
  - 验证：`...\shrinkly-fx\样片 目录\sample C.mp4` 从导入、估算、转换到结果卡片全程正常，输出文件落在同目录。

## 三、工程债 / 待改进

- [ ] `src/server/http/routes.ts` 里 `void sendJson` 等占位导入清理掉（避免误导）。
- [ ] 文件浏览器缺少「按修改时间排序 / 记住上次目录」。
- [ ] SSE 断线重连后需要手动刷新页面才能继续接收（可加自动重连提示）。
- [ ] 日志抽屉在 1 万条以上时的虚拟列表（当前截断到最近 600 条渲染）。
- [ ] 端口被占用时的错误提示（当前随机端口，冲突概率低）。
- [ ] 服务端单元测试：`http/router.ts` 的路由匹配、token 校验、fs 列表尚无用例。
- [ ] `runtime.json` 中的 token 会落盘，考虑加 600 权限或改用命名管道。
- [x] electron-builder 的 NSIS 打包在本机会失败：`Plugin not found, cannot call Nsis7z::Extract`。
  原因是缓存目录 `%LOCALAPPDATA%\electron-builder\Cache\nsis\nsis-resources-3.4.1` 被清空，
  但同版本的 `plugins` 仍在 `Cache\nsis-resources-3.4.1\` 下。已把 `plugins` 复制回去后打包成功；
  若在别的机器复现，同样处理即可（属于本机缓存问题，不是仓库代码问题）。

## 四、文档

- [x] README 已改写为浏览器 WebGUI 形态（启动方式 / 安全设计 / 目录结构 / 已知限制）。
- [x] docs/manual-checklist.md 已加入托盘、端口、token 相关检查项。
- [x] PLAN.md §13 记录了交付形态变更。
- [ ] 安装包（NSIS）的卸载流程与残留数据（`%APPDATA%\shrinkly`）说明。

## 五、简易模式增强（2026-10-24 20:30）

- [x] 简易模式输出格式选择
  - 4 个实际支持的容器（MP4 / MKV / WebM / MOV）+ 默认取源容器；选项里直接带扩展名，
    下方显示该容器的兼容性说明，右侧实时显示输出文件名与扩展名。
  - 切换格式时自动把不兼容编码换成该容器支持的第一项，并显示明确说明
    （如「视频编码 H.264 不受 WebM 支持，已改为 VP9；音频编码 AAC 不受 WebM 支持，
    已改为 Opus」），同时更新估算、命令摘要与任务参数。
  - 仍无法满足的硬约束（例如把 AAC 源音轨直接复制进 WebM）由校验拦截：
    显示「WebM 容器无法容纳源音轨（aac）」，并禁用「开始压缩」。
  - 实现：`src/shared/presets.ts` 的 `remapCodecsForContainer`、`SimpleMode.tsx`、
    `store.setContainer`；新增 `tests/unit/containers.test.ts`。
- [x] 硬件加速（GPU）三态选择
  - 启动后对每个编码族逐个实测（`h264_nvenc/qsv/amf` 等）：真的跑一次极短 lavfi 编码
    才算可用；本机实测 NVENC 可用、QSV/AMF 初始化失败。
  - 简易模式提供「自动检测 / 自动选择」「使用 CPU」「使用 GPU」；GPU 不可用时选项禁用
    并显示原因（未编译 / 驱动或设备不可用），可点「重新检测」重测。
  - 估算卡下方固定显示「计算方式：GPU（h264_nvenc）」或「CPU（libx264）」及原因。
  - 运行时 GPU 失败自动回退 CPU：`JobResult.hwFallback` + `hwFallbackReason`，
    结果卡显示「GPU 加速失败，已自动改用 CPU 完成转换。原因：…」，日志也有
    `[hw-fallback]` 记录。
  - 顺带修掉两个真实 bug：① QSV/AMF 被套用 NVENC 的 `-rc vbr -cq/p5` 参数导致必失败，
    现在 NVENC 用 `-cq`+p1–p7、QSV 用 `-global_quality`+x264 预设、AMF 用 CQP；
    ② 硬件编码器「打开失败」类 stderr（MFX session / preset 解析失败等）未被识别，
    不会触发回退。新增 `tests/unit/hardware.test.ts`、`tests/unit/errors.test.ts`。
- [x] 进度与任务状态可视化
  - 新增「任务进度」卡：总体百分比、当前第几个文件 / 总文件数、已处理大小 / 总大小、
    当前阶段（等待开始 / 准备中 / 编码中 / 已结束）、速度、预计剩余、最近进度更新时间。
  - 超过 20 秒没有进度更新时显示「可能卡住或正在等待」（不自动中止），并持续显示
    「最近进度更新 N 秒前」。
  - 成功 / 失败 / 已取消 / 已跳过分别用独立状态面板与计数标签；失败项列出文件名与错误
    标题，点击即选中该任务查看完整错误和 ffmpeg 原始输出。
  - 实现：`src/renderer/lib/progress.ts`、`ProgressPanel.tsx`、`ResultPanel.tsx`；
    新增 `tests/unit/progress.test.ts`。
- [x] 启动时机与防误触发
  - 队列改为「授权集合」：只有点击「开始压缩」时排队的任务才会执行；之后导入文件、
    改格式、改硬件加速、拖滑块都不会自动开跑（`enqueue` 不再 `pump`）。
  - 「开始压缩」在无待处理任务、无有效文件、ffmpeg 不可用、参数有错、队列运行中或
    正在启动时禁用；运行中按钮变为「取消当前任务」，进度卡另有「取消全部」。
  - 待处理文件只显示「等待开始」与「待处理 N 个文件，点击『开始压缩』后才会执行」。
  - 新增 `tests/unit/queue.test.ts` 覆盖「入队不启动」「运行中新入队不自动执行」
    「取消后不再执行」。
- [x] 回归验证
  - `npx vitest run` → 12 个文件 / 187 个用例通过；`npm run typecheck` 通过。
  - ego 空白 space 端到端：导入后保持「等待开始」；切 MP4/WebM/MOV 时扩展名与编码
    提示正确；GPU 自动选中 h264_nvenc 并成功转换；强制 h264_qsv 失败后自动回退
    libx264 且结果卡显示原因；CRF 99 时按钮禁用、重置后恢复。

## 六、恢复原生窗口（2026-10-24 21:30）

- [x] 默认形态改回 Electron 原生窗口
  - 窗口 1240×860（最小 1000×640）、标题栏、无地址栏、托盘、单实例聚焦；关闭窗口即退出。
  - 界面仍是同一份 React + 本地 HTTP（REST + SSE）：窗口加载 `http://127.0.0.1:<port>/?token=…`，
    与 WebUI 完全同源同代码；删除了此前为无窗口模式加的 `disable-gpu` 开关，恢复原生渲染。
  - 实现：`src/main/index.ts`、`src/main/ui-mode.ts`、`src/main/native.ts`、`src/preload/index.ts`。
- [x] 恢复原生交互
  - 拖拽文件 / 文件夹进窗口直接导入（`webUtils.getPathForFile` + `window.shrinkly`）；
  - 「添加文件夹 / 选择 ffmpeg / 输出目录」走系统对话框；
  - 结果卡「打开所在文件夹」优先用资源管理器定位；
  - 浏览器模式无桥接时自动退回原有的服务端文件浏览器。
- [x] 保留 WebUI 前端测试能力
  - `--web` / `SHRINKLY_WEB=1`：不建窗口，系统浏览器打开同一界面；
  - `SHRINKLY_NO_BROWSER=1`：只启动服务，适合 ego / Playwright 通过 `runtime.json` 的 token 直连；
  - `runtime.json` 增加 `mode` 字段。
- [x] 验证
  - `npx vitest run` → 13 个文件 / 191 用例通过（新增 `ui-mode.test.ts`）；`npm run typecheck` 通过。
  - 原生窗口：日志「界面模式：原生窗口 / 原生窗口已创建 / 原生桥接已就绪」，未再调用系统浏览器；
    经 CDP 在窗口内确认 `window.shrinkly` 就绪、拖拽区存在、ffmpeg 与 GPU 状态正常，
    并用真实点击跑完「入队 → 等待开始 → 开始压缩 → 完成」，SSE 进度正常。
  - `--web` 模式：ego 空白 space 中确认无桥接 / 无拖拽区、服务端文件浏览器回退可用，
    粘贴路径导入 → 等待开始 → GPU 转换成功。
