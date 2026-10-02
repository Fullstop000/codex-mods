# Codex Plugins

一个独立的 `codex-plugins` 命令，通过本机 Chrome DevTools Protocol（CDP）给已安装的官方 Codex / ChatGPT 桌面客户端添加运行时功能。

第一项功能是 **sidebar-time**：在项目侧栏的 thread 标题左边显示 `5m / 14h / 3d` 等相对时间。修改的是页面显示，不是 thread 名称或官方安装文件。

**状态：v0.1.0 实验版本。** CLI、真实 CDP 连接、DOM 注入、刷新、重载恢复和卸载已在 Chromium 测试页面中验证；尚未在你的官方客户端版本上实测。macOS / Windows 启动器是候选实现，不能保证所有商店安装包、历史版本或新版本都兼容。Linux 必须先有可连接的桌面客户端。

## 安装

需要 Node.js **22.6 或更新版本**。运行时不依赖第三方 npm 包；Playwright 仅用于开发测试。

从这个仓库安装：

```bash
git clone https://github.com/Fullstop000/codex-plugins.git
cd codex-plugins
npm install --global .
codex-plugins --help
```

私有仓库需要现有 GitHub Git 认证，也可用 `gh repo clone Fullstop000/codex-plugins`。目前没有发布到 npm registry，不能直接用 `npx @fullstop000/codex-plugins` 下载。

## 使用

首次使用前，保存当前工作并**完全退出官方桌面客户端**。已经普通启动的单实例应用可能吞掉新的 CDP 参数；本工具不会强制结束它。

```bash
codex-plugins enable sidebar-time
```

命令尝试找到已安装的 macOS / Windows 客户端并开启本机 CDP。保留这个终端运行：它会监视窗口，并在页面重载后重新注入。Ctrl+C 会清理标签和重载注册。

如果客户端安装在自定义位置，用可执行文件路径，不是 `.app` 目录，也不是 `codex` CLI：

```bash
# macOS 示例，路径以实际安装为准
codex-plugins enable sidebar-time --app /Applications/Codex.app/Contents/MacOS/Codex

# 已有 CDP 实例：只连接，不启动客户端
codex-plugins enable sidebar-time --no-launch --endpoint http://127.0.0.1:9222

# 在另一个终端检查连接和注入状态
codex-plugins doctor

# 在另一个终端停止插件并清理注入
codex-plugins disable sidebar-time
```

`enable` 输出 **labels visible** 才表示检测到了实际标签。输出 **waiting for supported thread rows and metadata** 表示仍在等待或需要适配，不代表功能已生效。`doctor` 不读取聊天正文、输出标题或触发注入；它报告可识别的 renderer 数量及已安装插件的计数。

停用插件不会退出桌面客户端，也不会关闭它的 CDP 端口。要关闭调试端口，需要退出桌面应用后，从官方普通入口重新打开。

## 时间与版本适配

- 默认使用 `recencyAt`，缺失时回退到 `updatedAt`；默认每 30 秒重新读取 metadata 和刷新显示。
- `--time-field updated` 显示更新时间，`--time-field created` 显示创建时间。
- 相对时间支持分钟、小时、天、月、年；标签的 `title` 和无障碍描述包含完整的本地日期时间。
- 自动读取 `electronBridge`、`codexBridge` 或 `electronAPI` 上的 `getInitialSidebarBootstrap()`，支持 `catalogSnapshot.entries` 和线程列表数组。
- 该 bridge 是**未公开保证稳定的内部接口**。初始 snapshot 是否反映后续活动取决于客户端版本；成功轮询不证明底层 snapshot 最新。如果该版本只返回启动时的缓存，就还需要增加该版本的活动订阅适配。
- 自动识别 `data-app-action-sidebar-thread-id`（例如 `local:<id>`）；在已识别侧栏中也支持 `data-thread-id`、`data-conversation-id` 和 `/thread/<id>`、`/threads/<id>`、`/c/<id>` 链接。
- 可回退到侧栏行上的 `data-recency-at` / `data-updated-at` 等明确属性。**不会依据标题、列表位置或猜测的时间匹配线程。** 无数据、无法识别或主机有歧义的行不会显示标签。
- 不覆盖原来的布局 display 属性；时间 span 插入到行首。真实客户端的复杂布局仍需实测。

以下参数供手动适配使用，不是普通用户的必需步骤：

```bash
codex-plugins enable sidebar-time \
  --no-launch \
  --row-selector 'aside [data-thread-id]' \
  --threads-file ./thread-times.json
```

行依然必须有可识别的 thread ID。metadata 文件可采用以下形式，时间支持 Unix 秒、Unix 毫秒或 ISO 日期字符串：

```json
[
  { "id": "thread-id", "hostId": "local", "recencyAt": 1790812800 }
]
```

文件是**静态快照**，在 `enable` 启动时读取。修改文件后需重新启用。缺少 `hostId` 的记录按本地 `local` 处理；远程记录应带明确主机 ID。不会主动从磁盘数据库猜读数据，也不会调用 `thread/name/set`。

## 命令选项

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `--endpoint` | `http://127.0.0.1:9222` | 本机 CDP origin |
| `--app` | 自动发现 | 官方桌面可执行文件 |
| `--no-launch` | 关闭 | 只连接已启动的 CDP |
| `--time-field` | `recency` | `recency` / `updated` / `created` |
| `--refresh-ms` | `30000` | 刷新间隔，1000–3600000 毫秒 |
| `--row-selector` | 自动 | 指定版本的行选择器 |
| `--threads-file` | 无 | 可选静态 metadata JSON |

本地状态存放在 `~/.codex-plugins`，只保存连接配置、watcher 所有权和 CDP 注入注册记录，不保存账号密钥或 thread 标题。可通过 `CODEX_PLUGINS_STATE_DIR` 改变目录。

## 工作方式与恢复

```text
codex-plugins
  → 发现或启动官方客户端的本机 CDP
  → 筛选 app:// renderer
  → 注册页面重载注入脚本
  → 读取线程时间 metadata
  → 按线程 ID 添加侧栏标签
  → 监视 DOM 重建、刷新时间
```

注入脚本可重复安装，旧 observer / timer 会被释放。watcher 保持 CDP session 打开，因为页面重载注册属于 session。`disable` 等待 watcher 移除 DOM 标签、样式、observer、timer 和重载注册后退出。watcher 崩溃时 CDP session 的重载注册随断开而消失，但当前页面上的 DOM 和 timer 可能仍在；磁盘记录供 `disable` 重新连接并清理这些残留。目标窗口已销毁时相应注入已消失；CDP 暂不可达时则明确报告清理未确认，此时重新运行 `disable` 或完全重启官方客户端。

客户端自动更新后重新运行 `doctor`。如果字段或 DOM 标记发生变化，需要更新适配器；这不是 OpenAI 官方插件 API。

## 验证与开发

```bash
npm ci
npm test
npm run check
npx playwright install chromium
npm run test:browser
```

可通过 `CHROMIUM_PATH=/path/to/chromium` 使用系统 Chromium。测试使用本机 HTTP fixture 和显式 `--fixture` 标志；正常使用只接受 `app://` 页面。fixture 标志不是官方客户端的启动模式。

| 检查 | 初版结果 |
| --- | --- |
| CDP URL 限制、CLI 校验、state 与 watcher 排他性 | 6 项单元测试通过 |
| 页面身份、有效内容、无错误覆盖层、控制台健康 | 通过，Chromium fixture |
| 时间格式、原始标题、点击动作、侧栏范围 | 通过 |
| 行替换、metadata 更新、跨主机同 ID、晚到的 bridge | 通过 |
| 重复注入、移除 DOM/observer、重载后自动恢复 | 通过 |
| 真 CLI → CDP → enable → reload → disable → reload | 通过 |
| 1100×650 和 390×650 布局 | 通过，标签未覆盖状态按钮 |
| 官方 Codex / ChatGPT 桌面版本、macOS / Windows 启动器 | **未实测** |

没有 Browser 插件的环境使用 Playwright。测试页面只是结构兼容性 fixture，不是官方客户端，不可作为其版本兼容证明。

## 边界

CDP 只能绑定本机回环地址，连接器拒绝外部地址和未验证的 WebSocket target。CDP 本身没有身份认证，本机其他进程可能访问该调试端口；仅在你信任的本机上使用。启动器不会修改安装包、关闭签名验证、添加 `--no-sandbox`、切换账号 profile 或强制终止应用。

项目不是 OpenAI 官方产品。仓库创建和源码发布不等于 npm 发布或你本地安装。

## 参考

本项目独立实现。以下资料用于研究 CDP 工作方式和候选客户端字段，没有复制其换肤/插件代码：

- [Codex Dream Skin](https://github.com/Fei-Away/Codex-Dream-Skin)：本机 CDP、DOM/CSS 注入和页面重载生命周期。
- [OpenCodex](https://github.com/RyensX/OpenCodex)：候选 desktop bootstrap 和侧栏线程 ID 标记。
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)。
- [上游时间显示 feature request #49895](https://github.com/openai/codex/issues/49895)。

Apache License 2.0。
