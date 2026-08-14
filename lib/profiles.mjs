// dsh-plugin-manager: profile/plugin read + mutation helpers.
import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

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

/** Merge bundles + patch entries into an id-keyed plugin list. */
export function listPlugins(profileName) {
  const { dir, bundles, patchEntries } = readProfile(profileName);
  const byId = new Map();
  for (const entry of patchEntries) {
    if (entry === null || typeof entry !== "object") continue;
    if (Array.isArray(entry.insert)) {
      for (const ins of entry.insert) {
        if (!ins || !ins.id) continue;
        byId.set(ins.id, { id: ins.id, name: ins.name ?? ins.id, source: "patch", disabled: false, kind: "insert" });
      }
      continue;
    }
    if (typeof entry.id === "string") {
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
    const existing = byId.get(id);
    byId.set(id, {
      id, name, source: "bundle",
      disabled: existing?.disabled ?? false, kind: "bundle",
      ...(pkg ? { version: pkg.version, description: pkg.description } : {}),
      ...(existing?.config !== undefined ? { config: existing.config } : {})
    });
  }
  return [...byId.values()];
}

/** Toggle a plugin's disabled flag by patching its row in cordis.patch.yml. */
export function setPluginDisabled(profileName, id, disabled) {
  const profile = readProfile(profileName);
  if (!fs.existsSync(profile.patchPath)) {
    fs.writeFileSync(profile.patchPath, "# dsh-plugin-manager patch layer\n", "utf8");
  }
  const doc = YAML.parseDocument(fs.readFileSync(profile.patchPath, "utf8"));
  const root = doc.contents;
  if (!root || root.type !== "SEQ") {
    // start a fresh sequence with a comment
    const seq = doc.createNode([]);
    doc.contents = seq;
  }
  const seq = doc.contents;
  let target = null;
  let targetIndex = -1;
  seq.items.forEach((item, i) => {
    if (item?.get?.("id") === id) { target = item; targetIndex = i; }
  });
  if (target === null) {
    // row doesn't exist: add a disabled/enabled row
    const row = doc.createNode({ id, name: id, disabled });
    seq.add(row);
  } else {
    if (disabled) target.set("disabled", true);
    else target.delete("disabled");
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

/** Install a package via the official dsh plugin command. */
export function installPlugin(profileName, packageName) {
  const dshBin = process.env.DSH_BIN || "dsh";
  const res = spawnSync(dshBin, ["plugin", "--profile", profileName, "add", packageName], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  });
  return { ok: res.status === 0, status: res.status, output: (res.stdout ?? "") + (res.stderr ?? "") };
}
