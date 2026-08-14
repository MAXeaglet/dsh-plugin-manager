#!/usr/bin/env node
// dsh-plugin-manager CLI: manage DSH plugins from the terminal. Cross-platform.
import { readFileSync } from "node:fs";
import {
  listProfiles, listPlugins, setPluginDisabled, setBundle, setBundleOrder,
  installPlugin, exportProfile, dshStatus, startDsh, stopDsh, checkUpdates
} from "./profiles.mjs";

const args = process.argv.slice(2);
const jsonFlag = args.includes("--json");

function defaultProfile() {
  const profiles = listProfiles();
  return profiles.includes("web") ? "web" : (profiles[0] ?? null);
}

// Parse argv: pull --profile <name> out (anywhere), keep positional args in order.
function parseArgv(raw) {
  const pos = [];
  let flagProfile = null;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === "--profile") { flagProfile = raw[++i]; }
    else if (a !== "--json") pos.push(a);
  }
  return { pos, flagProfile };
}
const { pos, flagProfile } = parseArgv(args);
const [cmd, ...rest] = pos;
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

function pickProfile(...idx) {
  return flagProfile ?? idx.map((i) => rest[i]).find((x) => x !== undefined) ?? defaultProfile();
}

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
  start [profile] [--port N]       启动 dsh web（默认 3080）
  stop                             停止 dsh web
  updates [profile]                检查插件更新
  export [profile]                 导出插件视图 JSON
  import <file> [profile]          从 JSON 导入
  gui                              启动桌面 GUI
`);
    break;
  case "profiles": out({ text: listProfiles().map((p) => (p === defaultProfile() ? "* " : "  ") + p).join("\n") }); break;
  case "list": renderPlugins(listPlugins(pickProfile(0))); break;
  case "enable": out(setPluginDisabled(pickProfile(1), rest[0], false)); break;
  case "disable": out(setPluginDisabled(pickProfile(1), rest[0], true)); break;
  case "add": out(installPlugin(pickProfile(1), rest[0])); break;
  case "remove": {
    const pname = pickProfile(1);
    const plugins = listPlugins(pname);
    const p = plugins.find((x) => x.id === rest[0]);
    if (!p) { out({ error: "plugin not found: " + rest[0] }); break; }
    if (p.kind === "bundle") out(setBundle(pname, p.name, false));
    else {
      const res = setPluginDisabled(pname, rest[0], true);
      out({ ...res, text: "已禁用 " + rest[0] + "（patch 行；完全移除请手动编辑 cordis.patch.yml）" });
    }
    break;
  }
  case "bundles": out({ text: (readProfileBundles(pickProfile(0)) || []).map((b) => "  " + b).join("\n") }); break;
  case "add-bundle": out(setBundle(pickProfile(1), rest[0], true)); break;
  case "remove-bundle": out(setBundle(pickProfile(1), rest[0], false)); break;
  case "reorder": out(setBundleOrder(pickProfile(1), rest[0].split(","))); break;
  case "config": {
    // rest[1] is either a JSON value or a profile name; detect JSON first.
    let jsonArg = undefined;
    let profArg = undefined;
    if (rest[1] !== undefined) {
      if (rest[1] === "null") jsonArg = "null";
      else if (rest[1].startsWith("{")) jsonArg = rest[1];
      else profArg = rest[1];
    }
    if (rest[2] !== undefined) profArg = rest[2];
    const pname = flagProfile ?? profArg ?? defaultProfile();
    const plugins = listPlugins(pname);
    const p = plugins.find((x) => x.id === rest[0]);
    if (jsonArg === undefined) {
      out({ text: p && p.config ? JSON.stringify(p.config, null, 2) : "（无 config）" });
    } else {
      const { setPluginConfig } = await import("./profiles.mjs");
      const val = jsonArg === "null" ? null : JSON.parse(jsonArg);
      out(setPluginConfig(pname, rest[0], val));
    }
    break;
  }
  case "status": {
    const portIdx = args.indexOf("--port");
    const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 3080;
    out(dshStatus(port && port > 0 ? port : 3080));
    break;
  }
  case "start": {
    const portIdx = args.indexOf("--port");
    const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : null;
    out(startDsh(pickProfile(0), { port: port && port > 0 ? port : null }));
    break;
  }
  case "stop": out(stopDsh()); break;
  case "updates": out({ text: (checkUpdates(pickProfile(0)) || []).map((u) => (u.hasUpdate ? "⬆" : "✓") + " " + u.name + "  " + u.local + " → " + (u.latest || "?")).join("\n") || "（无 bundle 插件）" }); break;
  case "export": out(exportProfile(pickProfile(0))); break;
  case "import": {
    const { importProfile } = await import("./profiles.mjs");
    const data = JSON.parse(readFileSync(rest[0], "utf8"));
    out(importProfile(pickProfile(1), data.bundles || [], data.patchEntries || null));
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
