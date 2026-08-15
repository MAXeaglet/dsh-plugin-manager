# 架构文档

> dsh-plugin-manager 的三种形态与双实现结构。

## 总览

一个工具，三种形态，共享同一套业务逻辑：

```
                ┌── 桌面 GUI（Tauri 2 + Rust 后端）── 推荐形态
dsh-plugin-manager ──  CLI（Node，lib/cli.mjs）──────────── 脚本/自动化
                └── WebUI（Node server，lib/server.mjs）── 浏览器快速访问
```

## 目录结构

| 路径 | 职责 |
|------|------|
| `src-tauri/` | Tauri 2 应用壳：Rust 命令层（lib.rs）+ 配置 |
| `web/` | 前端（单文件 index.html + style.css，无构建链） |
| `lib/profiles.mjs` | **核心业务逻辑**（Node 实现） |
| `lib/cli.mjs` | CLI 入口 |
| `lib/server.mjs` | WebUI 本地服务器 + JSON API |
| `test/` | 测试（单测 + API E2E + Chrome UI E2E） |

## 双实现模式（Node + Rust）

核心命令在 Node（webui/CLI）和 Rust（Tauri）各实现一份，行为必须一致：

| 功能 | Node | Rust |
|------|------|------|
| 列 profile | `listProfiles` | `list_profiles` |
| 列插件 | `listPlugins` | `list_plugins` |
| 启用/禁用 | `setPluginDisabled` | `set_plugin_disabled` |
| 设置 config | `setPluginConfig` | `set_plugin_config` |
| bundle 增删/排序 | `setBundle` / `setBundleOrder` | `set_bundle` / `set_bundle_order` |
| 安装/更新插件 | `installPlugin` / `updatePlugin` | `install_plugin` / `update_plugin` |
| 检查更新 | `checkUpdates` | `check_updates` |
| DSH 状态/启停 | `dshStatus` / `startDsh` / `stopDsh` | `dsh_status` / `start_dsh` / `stop_dsh` |
| 搜索插件 | `searchNpm` | `search_npm` |
| 导出/导入 | `exportProfile` / `importProfile` | `export_profile` / `import_profile` |
| 配置文件读写 | `readProfile`（内部） | `read_profile_files` / `write_profile_files` |
| DSH 本体更新 | `checkDshUpdate` / `updateDsh` | `check_dsh_update` / `update_dsh` |

**改逻辑时必须双端同步**——漏改一端会导致两个形态行为不一致（历史上踩过：bundle 禁用只在 Rust 修了，Node 漏了）。

## 数据模型

操作对象是 DSH profile 目录（`~/.dsh/profiles/<name>/`）：

- `package.json` — `dsh.profile.bundles` 数组（挂载的 bundle 包名）+ `dependencies`（用户安装的插件）
- `cordis.patch.yml` — 用户补丁层（启用/禁用/配置覆盖）

### 插件视图合并逻辑

`listPlugins` 合并三层来源：

1. 用户 patch 行（`cordis.patch.yml` 的普通条目）
2. 用户 patch 的 `insert` 条目
3. bundle 包（`dsh.profile.bundles` → 读包内 `cordis.patch.yml` 的 insert 声明）

**关键**：bundle 的真实插件 id 来自包内 patch 的 `- insert: - id: X`，不是包名拆分。禁用/配置必须写真实 id + 完整 name（DSH 按 id+name 匹配校验）。

## 前端状态机

`web/index.html` 是单文件应用，无框架。关键状态：

- `currentProfile` — 当前 profile
- `selectedId` — 选中插件（刷新后恢复，不跳回第一个）
- `plugins` — 当前插件列表快照
- `updates` — 有更新的插件映射
- `dshRunning` — dsh web 运行状态（10s 轮询）

## 平台差异处理

| 场景 | Windows | macOS/Linux |
|------|---------|-------------|
| 启动 dsh | `cmd /c start "" dsh web` | `nohup dsh web &` |
| 停止 dsh | PowerShell 按端口查 PID 杀 | `lsof` + `kill` |
| 检查 dsh 状态 | `Get-NetTCPConnection` | `lsof -iTCP` |
| 打开浏览器 | `start <url>` | `open` / `xdg-open` |
| npm/dsh 子进程 | 需要 `shell: true`（.cmd shim） | 直接 spawn |

