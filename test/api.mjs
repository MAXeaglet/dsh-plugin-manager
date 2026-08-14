// dsh-plugin-manager API tests against a throwaway profile (never touches real profiles).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { listPlugins, setPluginDisabled, setBundle, setPluginConfig, readProfile } from "../lib/profiles.mjs";

// redirect DSH_HOME to a temp dir
const tmp = mkdtempSync(join(tmpdir(), "dpm-test-"));
process.env.DSH_HOME = tmp;
const prof = join(tmp, "profiles", "web");
mkdirSync(join(prof, "node_modules"), { recursive: true });
// fake bundle package
mkdirSync(join(prof, "node_modules", "@deepseek-ai", "dsh-base"), { recursive: true });
writeFileSync(join(prof, "node_modules", "@deepseek-ai", "dsh-base", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-base", version: "0.1.0", description: "test base" }), "utf8");
// profile manifest with bundles
writeFileSync(join(prof, "package.json"), JSON.stringify({ name: "dsh-profile-web", dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }, null, 2) + "\n", "utf8");
// patch with one enabled row + one insert
writeFileSync(join(prof, "cordis.patch.yml"), "- id: tool-web\n  name: '@deepseek-ai/dsh-tool-web'\n  config:\n    search: false\n- insert:\n    - id: tool-bash-terminal\n      name: 'dsh-bash-terminal'\n", "utf8");
// fake bundle with its own bundle patch manifest (real inserted id != package short name)
mkdirSync(join(prof, "node_modules", "@dsh-external", "dsh-vision-toolkit"), { recursive: true });
writeFileSync(join(prof, "node_modules", "@dsh-external", "dsh-vision-toolkit", "package.json"), JSON.stringify({ name: "@dsh-external/dsh-vision-toolkit", version: "0.1.4" }), "utf8");
writeFileSync(join(prof, "node_modules", "@dsh-external", "dsh-vision-toolkit", "cordis.patch.yml"), "# bundle patch\n- insert:\n    - id: vision-toolkit\n      name: '@dsh-external/dsh-vision-toolkit'\n", "utf8");
writeFileSync(join(prof, "package.json"), JSON.stringify({ name: "dsh-profile-web", dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@dsh-external/dsh-vision-toolkit"] } } }, null, 2) + "\n", "utf8");

// 1. list merges bundles + patch
const plugins = listPlugins("web");
const ids = plugins.map((p) => p.id);
assert.ok(ids.includes("tool-web"), "patch row listed");
assert.ok(ids.includes("tool-bash-terminal"), "patch insert listed");
assert.ok(ids.includes("dsh-base"), "bundle listed");
const base = plugins.find((p) => p.id === "dsh-base");
assert.strictEqual(base.version, "0.1.0");

// 2. toggle disables a patch row
setPluginDisabled("web", "tool-web", true);
const after = listPlugins("web");
assert.strictEqual(after.find((p) => p.id === "tool-web").disabled, true, "row disabled");
const patchText = readFileSync(join(prof, "cordis.patch.yml"), "utf8");
assert.ok(patchText.includes("disabled: true"), "patch file carries disabled");

// 3. re-enable removes the flag
setPluginDisabled("web", "tool-web", false);
const re = listPlugins("web");
assert.strictEqual(re.find((p) => p.id === "tool-web").disabled, false, "row re-enabled");

// 4. bundle add/remove
setBundle("web", "@deepseek-ai/dsh-web-app", true);
assert.ok(readProfile("web").bundles.includes("@deepseek-ai/dsh-web-app"), "bundle added");
setBundle("web", "@deepseek-ai/dsh-web-app", false);
assert.ok(!readProfile("web").bundles.includes("@deepseek-ai/dsh-web-app"), "bundle removed");


// 5. regressions: enable/disable must NOT clobber name/config of an existing row
setPluginDisabled("web", "tool-web", true);
setPluginDisabled("web", "tool-web", false);
const preserved = readProfile("web").patchEntries.find((e) => e.id === "tool-web");
assert.strictEqual(preserved.name, "@deepseek-ai/dsh-tool-web", "name preserved through toggle");
assert.deepStrictEqual(preserved.config, { search: false }, "config preserved through toggle");

// 6. setPluginConfig updates in place, keeps other fields
setPluginConfig("web", "tool-web", { search: true, extra: 1 });
const cfg = readProfile("web").patchEntries.find((e) => e.id === "tool-web");
assert.deepStrictEqual(cfg.config, { search: true, extra: 1 }, "config updated");
assert.strictEqual(cfg.name, "@deepseek-ai/dsh-tool-web", "name intact after config set");

// 7. bundle disable expands to the REAL inserted id (package short name differs)
setPluginDisabled("web", "dsh-vision-toolkit", true);
const vtPatch = readFileSync(join(prof, "cordis.patch.yml"), "utf8");
assert.ok(vtPatch.includes("id: vision-toolkit") && vtPatch.includes("disabled: true"), "bundle disabled via real insert id");
assert.ok(vtPatch.includes("name: @dsh-external/dsh-vision-toolkit") || vtPatch.includes("name: '@dsh-external/dsh-vision-toolkit'") || vtPatch.includes('name: "@dsh-external/dsh-vision-toolkit"'), "canonical bundle name written (DSH validates name)");
assert.ok(!vtPatch.includes("id: dsh-vision-toolkit"), "no duplicate wrong-id row");
const vtPlugins = listPlugins("web");
const vtBundle = vtPlugins.find((p) => p.id === "dsh-vision-toolkit");
assert.strictEqual(vtBundle.disabled, true, "bundle shown disabled");
assert.ok(vtBundle.insertIds.includes("vision-toolkit"), "insertIds exposed");
// 8. re-enable removes the disabled flag
setPluginDisabled("web", "dsh-vision-toolkit", false);
const vtPlugins2 = listPlugins("web");
assert.strictEqual(vtPlugins2.find((p) => p.id === "dsh-vision-toolkit").disabled, false, "bundle re-enabled");
// 9. setPluginConfig on a bundle expands to real insert id (same fix as disable)
setPluginConfig("web", "dsh-vision-toolkit", { apiKey: "test" });
const cfgPatch = readFileSync(join(prof, "cordis.patch.yml"), "utf8");
assert.ok(cfgPatch.includes("id: vision-toolkit") && cfgPatch.includes("apiKey"), "bundle config written to real insert id");
assert.ok(!cfgPatch.includes("id: dsh-vision-toolkit"), "no wrong-id config row");
const cfgAfter = listPlugins("web").find((p) => p.id === "dsh-vision-toolkit");
assert.deepStrictEqual(cfgAfter.config, { apiKey: "test" }, "bundle config visible in list");

rmSync(tmp, { recursive: true, force: true });
console.log("API TESTS PASSED");

