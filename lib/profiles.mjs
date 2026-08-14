// dsh-plugin-manager: profile/plugin read + mutation helpers.
import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML, { isSeq } from "yaml";

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

export function profilesDir() {
  return join(dshHome(), "profiles");
}

export function profileDir(name) {
  return join(profilesDir(), name);
}

export function listProfiles() {
  const dir = profilesDir();
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "node_modules")
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; }
}

function readYaml(file) {
  try { return YAML.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; }
}

export function readProfile(name) {
  const dir = profileDir(name);
  const manifest = readJson(join(dir, "package.json")) ?? {};
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  const patchPath = join(dir, "cordis.patch.yml");
  const patch = fs.existsSync(patchPath) ? readYaml(patchPath) : undefined;
  const patchEntries = Array.isArray(patch) ? patch : [];
  return { name, dir, bundles, patchEntries, patchPath, manifest };
}

function bundlePackage(dir, name) {
  const candidates = [
    join(dir, "node_modules", name, "package.json"),
    join(profilesDir(), "node_modules", name, "package.json"),
    join(dshHome(), "profiles", "node_modules", name, "package.json")
  ];
  for (const c of candidates) {
    const p = readJson(c);
    if (p) return p;
  }
  return undefined;
}

/** Read a bundle package's cordis.patch.yml and collect real inserted plugin ids. */
export function bundleInsertIds(dir, name) {
  const candidates = [
    join(dir, "node_modules", name, "cordis.patch.yml"),
    join(profilesDir(), "node_modules", name, "cordis.patch.yml"),
  ];
  for (const c of candidates) {
    const doc = readYaml(c);
    if (!Array.isArray(doc)) continue;
    const ids = [];
    for (const entry of doc) {
      if (entry && Array.isArray(entry.insert)) {
        for (const ins of entry.insert) {
          if (ins && typeof ins.id === "string") ids.push(ins.id);
        }
      }
    }
    if (ids.length) return ids;
  }
  return [];
}

/** Merge bundles + patch entries into an id-keyed plugin list. */
export function listPlugins(profileName) {
  const { dir, bundles, patchEntries } = readProfile(profileName);
  const byId = new Map();
  // collect real insert ids per bundle so patch rows that belong to a bundle
  // are folded into the bundle entry instead of showing as duplicate rows
  const bundleInserts = new Map(); // bundleShortId -> Set(realInsertId)
  for (const name of bundles) {
    const ids = bundleInsertIds(dir, name);
    if (ids.length) bundleInserts.set(name.split("/").pop(), new Set(ids));
  }
  const allInsertIds = new Set([...bundleInserts.values()].flatMap((s) => [...s]));
  const rowDisabled = new Map(); // realInsertId -> disabled (patch rows folded into bundles)
  const rowConfig = new Map();   // realInsertId -> config

  for (const entry of patchEntries) {
    if (entry === null || typeof entry !== "object") continue;
    if (Array.isArray(entry.insert)) {
      for (const ins of entry.insert) {
        if (!ins || !ins.id) continue;
        if (allInsertIds.has(ins.id)) continue; // belongs to a bundle
        byId.set(ins.id, { id: ins.id, name: ins.name ?? ins.id, source: "patch", disabled: false, kind: "insert" });
      }
      continue;
    }
    if (typeof entry.id === "string") {
      if (allInsertIds.has(entry.id)) {
        rowDisabled.set(entry.id, entry.disabled === true);
        if (entry.config !== undefined) rowConfig.set(entry.id, entry.config);
        continue;
      }
      byId.set(entry.id, {
        id: entry.id, name: entry.name ?? entry.id, source: "patch",
        disabled: entry.disabled === true, kind: "row",
        ...(entry.config !== undefined ? { config: entry.config } : {})
      });
    }
  }

  for (const name of bundles) {
    const pkg = bundlePackage(dir, name);
    const id = name.split("/").pop();
    const insertIds = [...(bundleInserts.get(id) ?? [])];
    let disabled = false;
    if (insertIds.length) {
      disabled = insertIds.every((rid) => rowDisabled.get(rid) === true);
    } else {
      disabled = byId.get(id)?.disabled ?? false;
    }
    let config;
    for (const rid of insertIds) { if (rowConfig.has(rid)) { config = rowConfig.get(rid); break; } }
    const existing = byId.get(id);
    byId.set(id, {
      id, name, source: "bundle",
      disabled, kind: "bundle",
      ...(insertIds.length ? { insertIds } : {}),
      ...(pkg ? { version: pkg.version, description: pkg.description } : {}),
      ...(config !== undefined ? { config } : {}),
      ...(existing?.config !== undefined && config === undefined ? { config: existing.config } : {})
    });
  }
  return [...byId.values()];
}

/** Set disabled flag on a patch row. Bundles expand to their real inserted ids. */
function patchRowDisabled(doc, id, disabled) {
  const root = doc.contents;
  if (!isSeq(root)) {
    doc.contents = doc.createNode([]);
  }
  const seq = doc.contents;
  let target = null;
  seq.items.forEach((item) => { if (item?.get?.("id") === id) target = item; });
  if (target === null) {
    const row = doc.createNode({ id, name: id, ...(disabled ? { disabled: true } : {}) });
    seq.add(row);
  } else {
    if (disabled) target.set("disabled", true);
    else target.delete("disabled");
  }
}

/** Toggle a plugin's disabled flag by patching its row in cordis.patch.yml. */
export function setPluginDisabled(profileName, id, disabled) {
  const profile = readProfile(profileName);
  if (!fs.existsSync(profile.patchPath)) {
    fs.writeFileSync(profile.patchPath, "# dsh-plugin-manager patch layer\n", "utf8");
  }
  const doc = YAML.parseDocument(fs.readFileSync(profile.patchPath, "utf8"));
  // bundle id (package-short name): resolve full package name from bundles list
  let insertIds = [];
  const full = profile.bundles.find((b) => b.split("/").pop() === id);
  if (full) insertIds = bundleInsertIds(profile.dir, full);
  if (insertIds.length) {
    for (const rid of insertIds) patchRowDisabled(doc, rid, disabled);
  } else {
    patchRowDisabled(doc, id, disabled);
  }
  fs.writeFileSync(profile.patchPath, doc.toString(), "utf8");
  return { id, disabled, patchPath: profile.patchPath };
}

/** Add a bundle to the profile's dsh.profile.bundles (or remove it). */
export function setBundle(profileName, bundleName, enabled) {
  const profile = readProfile(profileName);
  const manifestPath = join(profile.dir, "package.json");
  const manifest = profile.manifest;
  if (!manifest.dsh) manifest.dsh = {};
  if (!manifest.dsh.profile) manifest.dsh.profile = {};
  let bundles = manifest.dsh.profile.bundles ?? [];
  if (enabled && !bundles.includes(bundleName)) bundles.push(bundleName);
  if (!enabled) bundles = bundles.filter((b) => b !== bundleName);
  manifest.dsh.profile.bundles = bundles;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { bundleName, enabled, bundles };
}

/** Reorder the profile's dsh.profile.bundles list (drag-and-drop). */
export function installPlugin(profileName, packageName) {
  const dshBin = process.env.DSH_BIN || "dsh";
  const res = spawnSync(dshBin, ["plugin", "--profile", profileName, "add", packageName], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  });
  return { ok: res.status === 0, status: res.status, output: (res.stdout ?? "") + (res.stderr ?? "") };
}

// --- CLI helpers: dsh lifecycle + update check (cross-platform) ---

export function dshStatus(port = 3080) {
  try {
    const res = spawnSync(process.platform === "win32" ? "powershell" : "sh",
      process.platform === "win32"
        ? ["-NoProfile", "-Command", "Get-NetTCPConnection -LocalPort " + port + " -State Listen -ErrorAction SilentlyContinue"]
        : ["-c", "lsof -iTCP:" + port + " -sTCP:LISTEN >/dev/null 2>&1 && echo running"],
      { encoding: "utf8" });
    return { running: res.status === 0 && res.stdout.trim().length > 0, port };
  } catch {
    return { running: false, port };
  }
}

export function startDsh(profileName, opts = {}) {
  // "dsh web" = dsh --profile web (the default UI). Putting --profile after
  // "web" is invalid: web does not take a --profile option. Boot web.
  const port = opts.port ? String(opts.port) : null;
  const args = ["web", ...(port ? ["--port", port] : [])];
  try {
    if (process.platform === "win32") {
      spawnSync("cmd", ["/c", "start", "", "dsh", ...args], { stdio: "ignore", detached: true });
    } else {
      spawnSync("sh", ["-c", "nohup dsh " + args.join(" ") + " >/dev/null 2>&1 &"], { stdio: "ignore", detached: true });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function stopDsh() {
  try {
    const res = process.platform === "win32"
      ? spawnSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name like '%node%'\" | Where-Object { $_.CommandLine -match 'dsh' -and $_.CommandLine -match 'web' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { encoding: "utf8" })
      : spawnSync("sh", ["-c", "pkill -f 'dsh web'"], { encoding: "utf8" });
    return { ok: res.status === 0 };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function checkUpdates(profileName) {
  const out = [];
  for (const p of listPlugins(profileName)) {
    if (p.kind !== "bundle" || !p.version) continue;
    let latest;
    try {
      const res = spawnSync("npm", ["view", p.name, "version"], { encoding: "utf8" });
      latest = res.status === 0 ? res.stdout.trim() : undefined;
    } catch { latest = undefined; }
    out.push({ id: p.id, name: p.name, local: p.version, latest: latest ?? null, hasUpdate: !!latest && latest !== p.version });
  }
  return out;
}

export function setPluginConfig(profileName, id, config) {
  const profile = readProfile(profileName);
  const path = profile.patchPath;
  if (!fs.existsSync(path)) fs.writeFileSync(path, "# dsh-plugin-manager patch layer\n", "utf8");
  const doc = YAML.parseDocument(fs.readFileSync(path, "utf8"));
  const root = doc.contents;
  if (!isSeq(root)) {
    doc.contents = doc.createNode([]);
  }
  const seq = doc.contents;
  let target = null;
  seq.items.forEach((item) => { if (item?.get?.("id") === id) target = item; });
  if (target) {
    if (config === null || config === undefined) target.delete("config");
    else target.set("config", config);
  } else {
    const row = doc.createNode({ id, name: id, ...(config ? { config } : {}) });
    seq.add(row);
  }
  fs.writeFileSync(path, doc.toString(), "utf8");
  return { id, config: config ?? null };
}

export function importProfile(profileName, bundles, patch) {
  const profile = readProfile(profileName);
  if (Array.isArray(bundles)) {
    const manifestPath = join(profile.dir, "package.json");
    const manifest = profile.manifest;
    if (!manifest.dsh) manifest.dsh = {};
    if (!manifest.dsh.profile) manifest.dsh.profile = {};
    manifest.dsh.profile.bundles = bundles;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  }
  if (patch !== null && patch !== undefined) {
    fs.writeFileSync(profile.patchPath, YAML.stringify(patch), "utf8");
  }
  return { profile: profileName, imported: true };
}

export function setBundleOrder(profileName, ordered) {
  const profile = readProfile(profileName);
  const manifestPath = join(profile.dir, "package.json");
  const manifest = profile.manifest;
  if (!manifest.dsh) manifest.dsh = {};
  if (!manifest.dsh.profile) manifest.dsh.profile = {};
  manifest.dsh.profile.bundles = ordered;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { bundles: ordered };
}

export function exportProfile(profileName) {
  const profile = readProfile(profileName);
  return {
    profile: profileName,
    bundles: profile.bundles,
    patchEntries: profile.patchEntries.filter((e) => e !== null && typeof e === "object"),
    plugins: listPlugins(profileName)
  };
}
