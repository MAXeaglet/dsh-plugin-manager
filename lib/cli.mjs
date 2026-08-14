#!/usr/bin/env node
// dsh-plugin-manager CLI: manage DSH plugins from the terminal. Cross-platform.
import { readFileSync } from "node:fs";
import {
  listProfiles, listPlugins, setPluginDisabled, setBundle, setBundleOrder,
  installPlugin, exportProfile, dshStatus, startDsh, stopDsh, checkUpdates
} from "./profiles.mjs";

const args = process.argv.slice(2);
const jsonFlag = args.includes("--json");
const argv = args.filter((a) => a !== "--json");

function defaultProfile() {
  const profiles = listProfiles();
  return profiles.includes("web") ? "web" : (profiles[0] ?? null);
}
function out(obj) {
  if (jsonFlag) { console.log(JSON.stringify(obj, null, 2)); return; }
  if (obj.error) { console.error("✗ " + obj.error); process.exitCode = 1; return; }
  if (obj.ok === false) { console.error("✗ " + (obj.error || "failed")); process.exitCode = 1; return; }
  console.log(obj.text ?? JSON.stringify(obj));
}
function renderPlugins(plugins) {
  if (jsonFlag) return out(plugins);
  const rows = plugins.map((p) =>
    (p.disabled ? "⛔" : "✅") + " " + p.id.padEnd(24) +
    (p.kind === "bundle" ? "bundle  " : "patch   ") +
    (p.version ? "v" + p.version.padEnd(8) : "        ") +
    (p.description ? p.description.slice(0, 60) : "")
  );
  return out({ text: rows.length ? rows.join("\n") : "（无插件）" });
}

const [cmd, a1, a2, a3] = argv;
const profile = (a2 === "--profile" ? a3 : null) ?? defaultProfile();

switch (cmd) {
  case undefined:
  case "--help":
  case "-h":
  case "help":
    console.log(`dsh-plugin-manager — DSH 插件管理 CLI

用法: dsh-plugin-manager <命令> [参数] [--profile <name>] [--json]

命令:
  profiles                         列出 profile
  list [profile]                   列出插件
  enable <id> [profile]            启用插件
  disable <id> [profile]           禁用插件
  add <package> [profile]          安装插件 (dsh plugin add)
  remove <id> [profile]            移除插件（从 patch/bundles）
  bundles [profile]                列出 bundles
  add-bundle <name> [profile]      添加 bundle
  remove-bundle <name> [profile]   移除 bundle
  reorder <n1,n2,...> [profile]    排序 bundles
  config <id> [json] [profile]     查看/设置插件 config（JSON，省略为查看）
  status                           查看 dsh web 状态
  start [profile]                  启动 dsh web
  stop                             停止 dsh web
  updates [profile]                检查插件更新
  export [profile]                 导出插件视图 JSON
  import <file> [profile]          从 JSON 导入
  gui                              启动桌面 GUI
`);
    break;
  case "profiles": out({ text: listProfiles().map((p) => (p === profile ? "* " : "  ") + p).join("\n") }); break;
  case "list": renderPlugins(listPlugins(profile)); break;
  case "enable": out(setPluginDisabled(profile, a1, false)); break;
  case "disable": out(setPluginDisabled(profile, a1, true)); break;
  case "add": out(installPlugin(profile, a1)); break;
  case "remove": {
    const plugins = listPlugins(profile);
    const p = plugins.find((x) => x.id === a1);
    if (!p) { out({ error: "plugin not found: " + a1 }); break; }
    if (p.kind === "bundle") out(setBundle(profile, p.name, false));
    else {
      const res = setPluginDisabled(profile, a1, true);
      out({ ...res, text: "已禁用 " + a1 + "（patch 行；完全移除请手动编辑 cordis.patch.yml）" });
    }
    break;
  }
  case "bundles": out({ text: (readProfileBundles(profile) || []).map((b) => "  " + b).join("\n") }); break;
  case "add-bundle": out(setBundle(profile, a1, true)); break;
  case "remove-bundle": out(setBundle(profile, a1, false)); break;
  case "reorder": out(setBundleOrder(profile, a1.split(","))); break;
  case "config": {
    if (a2 === undefined) {
      const plugins = listPlugins(profile);
      const p = plugins.find((x) => x.id === a1);
      out({ text: p && p.config ? JSON.stringify(p.config, null, 2) : "（无 config）" });
    } else {
      const { setPluginConfig } = await import("./profiles.mjs");
      out(setPluginConfig(profile, a1, a2 === "null" ? null : JSON.parse(a2)));
    }
    break;
  }
  case "status": out(dshStatus()); break;
  case "start": out(startDsh(profile)); break;
  case "stop": out(stopDsh()); break;
  case "updates": out({ text: (checkUpdates(profile) || []).map((u) => (u.hasUpdate ? "⬆" : "✓") + " " + u.name + "  " + u.local + " → " + (u.latest || "?")).join("\n") || "（无 bundle 插件）" }); break;
  case "export": out(exportProfile(profile)); break;
  case "import": {
    const { importProfile } = await import("./profiles.mjs");
    const data = JSON.parse(readFileSync(a1, "utf8"));
    out(importProfile(profile, data.bundles || [], data.patchEntries || null));
    break;
  }
  case "gui": {
    await import("./server.mjs");
    break;
  }
  default:
    out({ error: "未知命令: " + cmd + "（--help 查看用法）" });
}

function readProfileBundles(profileName) {
  return listPlugins(profileName).filter((p) => p.kind === "bundle").map((p) => p.name);
}
