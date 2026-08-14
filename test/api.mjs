// dsh-plugin-manager API tests against a throwaway profile (never touches real profiles).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { listPlugins, setPluginDisabled, setBundle, readProfile } from "../lib/profiles.mjs";

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

rmSync(tmp, { recursive: true, force: true });
console.log("API TESTS PASSED");
