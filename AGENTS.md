# AGENTS.md — dsh-plugin-manager

DSH 插件管理器：桌面 GUI（Tauri 2 + Rust）+ CLI + WebUI，管理 DSH 的 profile / 插件，一键启动 dsh web。

## 项目结构

| 目录 | 说明 |
|------|------|
| `src-tauri/` | Tauri 2 Rust 后端（命令层，lib.rs） |
| `web/` | 前端（单文件 index.html + style.css，无构建） |
| `lib/` | Node 逻辑（profiles.mjs / cli.mjs / server.mjs） |
| `test/` | 测试（api.mjs 单测 + e2e-api.mjs + e2e-ui.mjs） |

## 关键约定

- 前端是单 HTML 文件，改完必须重编译 exe（frontendDist 嵌入二进制）
- 构建必须 MSVC 工具链（vcvars64 + cargo +stable-x86_64-pc-windows-msvc）
- 改 bundle 逻辑注意真实 insert id（DSH 校验 id+name 匹配）
- 杀进程只用精确 PID，禁止 taskkill //IM 宽泛匹配
- 写 JS 字符串避免转义（用 String.fromCharCode / createElement）

## Agent skills

### Issue tracker

Issues and PRDs live as GitHub issues (via `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles mapped to GitHub labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.
