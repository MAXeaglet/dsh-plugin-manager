// dsh-plugin-manager: local web server + JSON API.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync as fs_exists, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listProfiles, listPlugins, setPluginDisabled, setBundle, setBundleOrder, exportProfile, installPlugin, profileDir, profilesDir, dshStatus, startDsh, stopDsh } from "./profiles.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(root, "web");
const PORT = Number(process.env.PORT || 5177);

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  try {
    // JSON API
    if (path === "/api/debug") {
      const os = await import("node:os");
      const pm = await import("./profiles.mjs");
      let readdir;
      try { readdir = require_list(pm.profilesDir()); } catch (e) { readdir = "ERR: " + e.message; }
      return json(res, 200, {
        homedir: os.homedir(),
        DSH_HOME: process.env.DSH_HOME,
        cwd: process.cwd(),
        dshHome: pm.dshHome(),
        profilesDir: pm.profilesDir(),
        readdir
      });
      function require_list(dir) {
        const fs2 = require("node:fs");
        return fs2.readdirSync(dir);
      }
    }
    if (path === "/api/profiles") {
      const profiles = listProfiles();
      return json(res, 200, { profiles, current: url.searchParams.get("profile") || profiles[0] || null });
    }
    if (path === "/api/plugins") {
      const profile = url.searchParams.get("profile");
      if (!profile) return json(res, 400, { error: "profile required" });
      const plugins = listPlugins(profile);
      return json(res, 200, { profile, plugins });
    }
    if (path === "/api/toggle" && req.method === "POST") {
      const body = await readBody(req);
      const { profile, id, disabled } = body;
      const result = setPluginDisabled(profile, id, disabled === true);
      return json(res, 200, result);
    }
    if (path === "/api/bundle" && req.method === "POST") {
      const body = await readBody(req);
      const { profile, name, enabled } = body;
      const result = setBundle(profile, name, enabled === true);
      return json(res, 200, result);
    }
    if (path === "/api/reorder" && req.method === "POST") {
      const body = await readBody(req);
      const { profile, bundles } = body;
      if (!Array.isArray(bundles)) return json(res, 400, { error: "bundles array required" });
      return json(res, 200, setBundleOrder(profile, bundles));
    }
    if (path === "/api/export") {
      const profile = url.searchParams.get("profile");
      if (!profile) return json(res, 400, { error: "profile required" });
      return json(res, 200, exportProfile(profile));
    }
    if (path === "/api/install" && req.method === "POST") {
      const body = await readBody(req);
      const { profile, package: pkg } = body;
      if (!pkg) return json(res, 400, { error: "package required" });
      const result = installPlugin(profile, pkg);
      return json(res, result.ok ? 200 : 500, result);
    }
    if (path === "/api/dsh-status") {
      const port = Number(url.searchParams.get("port") || 3080);
      return json(res, 200, dshStatus(port));
    }
    if (path === "/api/dsh-start" && req.method === "POST") {
      const body = await readBody(req);
      const port = Number(body.port || 3080);
      return json(res, 200, startDsh(body.profile || "web", { port: port > 0 ? port : null }));
    }
    if (path === "/api/dsh-stop" && req.method === "POST") {
      return json(res, 200, stopDsh());
    }
    if (path === "/api/readme") {
      const profile = url.searchParams.get("profile");
      const name = url.searchParams.get("name");
      if (!profile || !name) return json(res, 400, { error: "profile+name required" });
      const candidates = [
        join(profileDir(profile), "node_modules", name),
        join(profilesDir(), "node_modules", name),
      ];
      const dir = candidates.find((c) => fs_exists(c));
      let text = null;
      if (dir) {
        for (const f of ["README.md", "readme.md", "Readme.md"]) {
          const p = join(dir, f);
          if (fs_exists(p)) { try { text = readFileSync(p, "utf8").slice(0, 8000); } catch {} break; }
        }
      }
      return json(res, 200, text !== null ? { ok: true, readme: text } : { ok: false, error: "no README" });
    }
    if (path === "/api/profile-files") {
      const profile = url.searchParams.get("profile");
      if (!profile) return json(res, 400, { error: "profile required" });
      const dir = profileDir(profile);
      const rd = (f) => { try { return readFileSync(join(dir, f), "utf8"); } catch { return ""; } };
      return json(res, 200, { manifest: rd("package.json"), patch: rd("cordis.patch.yml") });
    }
    // static web
    const safe = path === "/" ? "/index.html" : path;
    const file = join(webDir, safe);
    if (!file.startsWith(webDir)) return json(res, 403, { error: "forbidden" });
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
      res.end(data);
    } catch {
      return json(res, 404, { error: "not found" });
    }
  } catch (e) {
    return json(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log("dsh-plugin-manager: http://127.0.0.1:" + PORT);
  console.log("profiles:", listProfiles().join(", "));
});
