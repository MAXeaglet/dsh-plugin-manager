# 开发指南

> 构建、测试、发布的完整流程。

## 环境要求

- Node.js ≥ 20
- Rust（stable），Windows 需 **MSVC 工具链**（GNU/mingw 链接 Tauri 会报 `export ordinal too large`）
- pnpm（DSH 的 plugin 命令转发给它）

## 本地开发

```bash
npm install          # tauri cli 等
npm test             # Node 单测
npx tauri dev        # 桌面 GUI（热重载）
node lib/server.mjs  # WebUI（http://127.0.0.1:5177）
node lib/cli.mjs --help  # CLI
```

## 测试金字塔

```bash
node test/api.mjs          # 1) Node 单测（临时 profile，不碰真实数据）
node test/e2e-api.mjs      # 2) API 端到端（webui server + fetch）
node test/e2e-ui.mjs       # 3) Chrome UI 端到端（playwright-core + 系统 Chrome）
cargo test                 # 4) Rust 单测（MSVC toolchain）
```

**E2E 前置**：需要系统 Chrome（`C:/Program Files/Google/Chrome/Application/chrome.exe`）和 playwright-core：

```bash
cd /tmp && npm i playwright-core
```

## 构建桌面安装包

### Debug（开发）

```bat
:: Windows 必须 MSVC：先跑 vcvars64 再 cargo
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
cd src-tauri
cargo +stable-x86_64-pc-windows-msvc build
:: 产物：src-tauri/target/debug/dsh-plugin-manager.exe
```

### Release（发布）

```bash
npx tauri build --bundles nsis   # Windows 安装包
```

**注意**：前端（web/）改动后**必须重编译**——frontendDist 嵌入二进制，只改 HTML 不重编译不生效。

## 多平台发布（CI）

`.github/workflows/release.yml` 在三个平台 runner 自动构建：

```bash
git tag v0.2.5 && git push origin v0.2.5   # 触发三平台构建 + 发布
# 或 GitHub Actions 页面手动 workflow_dispatch
```

产物自动上传到对应 tag 的 release：

| 平台 | 产物 |
|------|------|
| Windows | NSIS .exe + MSI |
| macOS | .dmg + .app.tar.gz |
| Linux | .deb + .rpm + .AppImage |

## npm 发布

```bash
npm publish --access public   # @maxeagle/dsh-plugin-manager
npm i -g @maxeagle/dsh-plugin-manager  # 用户安装（CLI: dshpm）
```

## 版本管理

版本号需同步三处：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`。

## 发布 Checklist

1. [ ] `node test/api.mjs` 通过
2. [ ] `node test/e2e-api.mjs` 通过
3. [ ] `node test/e2e-ui.mjs` 通过（有 Chrome）
4. [ ] Rust `cargo test` 通过
5. [ ] 三处版本号同步 bump
6. [ ] `npm publish`
7. [ ] `git tag vX.Y.Z && git push origin vX.Y.Z`（触发三平台 CI）
8. [ ] CI 完成后发布 draft release

