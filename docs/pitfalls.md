# 踩坑记录

> 开发过程中遇到的真问题与解决方案，避免重蹈覆辙。

## 1. DSH bundle 插件的真实 id 来自包内 patch（最重要）

**现象**：GUI 禁用 `dsh-vision-toolkit` 后启动 dsh 仍加载。

**根因**：bundle 包（如 `@dsh-external/dsh-vision-toolkit`）的真实插件 id 是包内 `cordis.patch.yml` 声明的 `- insert: - id: vision-toolkit`，**不是包名拆分**（`dsh-vision-toolkit`）。写错 id 的 patch 行被 DSH 忽略。

**第二层坑**：DSH 校验 patch 行的 **name 必须与 insert 一致**（完整包名）。即使 id 对了，name 写短名也会被 `skipping`。

**解法**：读 bundle 包内 patch 提取 `{id, name}` 行，写禁用/配置时用真实 id + 完整 name。

## 2. Node spawn npm/dsh 在 Windows 上 ENOENT

**现象**：`spawnSync("npm", ...)` 返回 ENOENT；GUI 搜索/安装插件静默失败。

**根因**：npm 和 dsh 都是 `.cmd` shim（nvm 安装），Node 的 spawn 不解析 .cmd。

**解法**：`spawnSync(..., { shell: process.platform === "win32" })`。Rust 的 `Command::new("npm")` 没这问题（CreateProcess 查 PATHEXT）。

## 3. 版本比较必须 semver，不能字符串比较

**现象**：`0.1.0-rc.6` vs `0.0.1-rc.1` 被误判"有更新"。

**根因**：字符串比较两者不等，但 semver 上 0.1.0 > 0.0.1。

**解法**：轻量 semver 比较（Node + Rust 各一份），处理 major.minor.patch[-prerelease]。

## 4. Tauri v2 默认拒绝所有权限

**现象**：GitHub 按钮（opener 插件）静默失败。

**根因**：没有 `src-tauri/capabilities/` 配置，`opener:default` 权限缺失。

**解法**：创建 `capabilities/default.json`，含 `core:default` + `opener:default`。

## 5. 杀进程严禁宽泛匹配

**现象**：`taskkill //IM node.exe` 把 DSH 自己杀了（DSH 也是 node）。

**解法**：只用精确 PID；杀前先验证身份。`stop_dsh` 改按端口查监听者 PID 再杀。

## 6. 前端 JS 里写字符串的转义陷阱

**现象**：字符串里的换行转义变成跨行 → 整个 `<script>` 语法错误 → 界面空白、点击无响应。

**根因**：在模板里写转义引号会被解析成裸引号破坏语法。

**解法**：用 `String.fromCharCode(10)` 代替换行转义；用 `createElement` 构建 DOM 而非字符串拼接 HTML。改完前端先跑语法检查再交付。

## 7. 替换函数时注意边界

**现象**：替换 openSearch 后语法错误。

**根因**：用 `indexOf` 找函数结束，匹配到了内部嵌套的括号。

**解法**：精确匹配整个函数体，或先删旧函数再插新的。

## 8. webui 模式（server.mjs）路由容易漏

**现象**：GUI（Tauri）功能正常，但 `dshpm gui` 里 404。

**根因**：server.mjs 是手写路由，新增 Rust 命令时容易漏同步。历史上漏过：config、purge、search、updates、open-repo。

**解法**：新增功能时前端 api() 的每个 case 都要在 server.mjs 有对应路由；用 `test/e2e-api.mjs` 覆盖。

## 9. Windows 构建必须 MSVC 工具链

**现象**：GNU/mingw 链接 Tauri 报 `export ordinal too large`。

**解法**：`vcvars64.bat` + `cargo +stable-x86_64-pc-windows-msvc`。

## 10. 轮询越少越好

**现象**：状态刷新每秒轮询（纯浪费）。

**解法**：改为事件驱动；保留必要的 dsh 状态 10s 轮询。

