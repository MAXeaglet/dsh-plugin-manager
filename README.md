# dsh-plugin-manager

> 社区交流：[LINUX DO](https://linux.do) · [GitHub](https://github.com/MAXeaglet/dsh-plugin-manager)

DSH 插件管理器：管理 dsh 的 profile / 插件，一键启动 dsh web。桌面 GUI（Tauri 2）+ CLI，跨平台（Windows / macOS / Linux）。

> 独立工具，不是 DSH 插件：直接读写 profile 文件（`~/.dsh/profiles/<name>/`），不挂载进 DSH。

## 安装

**桌面 GUI**（推荐）：从 [GitHub Releases](https://github.com/MAXeaglet/dsh-plugin-manager/releases) 下载安装包（GitHub Actions 自动构建三平台）：

- **Windows**：`.exe`（NSIS）/ `.msi`
- **macOS**：`.dmg`（Apple Silicon）
- **Linux**：`.deb` / `.rpm` / `.AppImage`

**CLI**（npm）：

```bash
npm i -g @maxeagle/dsh-plugin-manager
dsh-plugin-manager --help   # 或别名 dshpm --help
```

CLI 也可启动本地 WebUI（浏览器版界面）：

```bash
dsh-plugin-manager gui   # http://127.0.0.1:5177
```

## 功能

- 按 profile 管理插件（合并 `dsh.profile.bundles` + `cordis.patch.yml`）
- 一键 **启用 / 禁用**（写入 `cordis.patch.yml`）、**添加 / 移除 / 拖拽排序** bundles
- **🧹 纯净模式**：一键禁用所有第三方插件（仅保留 `@deepseek-ai/` 官方）
- **▶ 启动 dsh web**：可配置端口（默认 3080），一键启动 / 停止
- **🔍 装插件**：搜索 npm 并安装
- 编辑插件 **config**（JSON）、**导出 / 导入** profile 视图
- 检查更新、搜索过滤、亮/暗主题、profile 切换、中英文

## CLI

```bash
dsh-plugin-manager profiles               # 列出 profile
dsh-plugin-manager list [profile]         # 列出插件
dsh-plugin-manager enable|disable <id> [profile]
dsh-plugin-manager add <package> [profile]     # dsh plugin add
dsh-plugin-manager add-bundle|remove-bundle <name> [profile]
dsh-plugin-manager reorder <n1,n2,...> [profile]
dsh-plugin-manager config <id> [json] [profile]  # 查看/设置插件 config
dsh-plugin-manager status [--port N]      # dsh web 状态（默认 3080）
dsh-plugin-manager start [--port N]       # 启动 dsh web
dsh-plugin-manager stop                    # 停止 dsh web
dsh-plugin-manager updates [profile]       # 检查更新
dsh-plugin-manager export [profile]        # 导出 JSON
dsh-plugin-manager import <file> [profile] # 导入 JSON
dsh-plugin-manager gui                     # 启动 WebUI
```

## Develop

```bash
npm install              # tauri cli
npx tauri dev            # run the desktop app (Rust backend + web frontend)
```

## Cross-platform

Works on Windows / macOS / Linux. Build per platform:

```bash
# macOS (requires Xcode Command Line Tools + rustup)
rustup toolchain list                        # ensure a native toolchain is default
npx tauri build                              # -> target/release/bundle/macos/*.app or .dmg

# Linux (requires webkit2gtk etc. system libs)
npx tauri build
```

On Windows prefer the MSVC toolchain when linking Tauri (`cargo +stable-x86_64-pc-windows-msvc build`)
— the GNU/mingw linker can fail with `export ordinal too large`.

## Build

```bash
npx tauri build          # produces the desktop bundle (Windows / macOS / Linux)
```

## WebUI fallback

浏览器版界面（与 GUI 相同的前端，走 Node API）：

```bash
dsh-plugin-manager gui   # http://127.0.0.1:5177
```

## Backend (Tauri commands)

| Command | Description |
|---------|-------------|
| `list_profiles` | profiles under `~/.dsh/profiles` |
| `list_plugins` | merged plugin list for a profile |
| `set_plugin_disabled` | toggle a patch row's `disabled` flag |
| `set_bundle` | add/remove a `dsh.profile.bundles` entry |
| `set_bundle_order` | reorder bundles |
| `export_profile` | JSON export of the plugin view |
| `install_plugin` | `dsh plugin add` |
| `set_plugin_config` | set a plugin row's `config` |
| `purge_third_party` | pure mode: disable all non-`@deepseek-ai/` plugins |
| `start_dsh` / `stop_dsh` | start (with optional port) / stop dsh web |
| `dsh_status` | is dsh web listening (port-aware) |
| `search_npm` | search npm for DSH plugins |
| `check_updates` | compare bundle versions with npm |
| `import_profile` / `export_profile` | import/export profile view |

## Test

```bash
node test/api.mjs            # Node profiles logic (throwaway profile)
cargo +stable-x86_64-pc-windows-msvc test   # Rust commands: list/toggle/bundle/reorder/backup
```
