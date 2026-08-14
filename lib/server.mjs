// dsh-plugin-manager: local web server + JSON API.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listProfiles, listPlugins, setPluginDisabled, setBundle, installPlugin, profileDir } from "./profiles.mjs";

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
    if (path === "/api/install" && req.method === "POST") {
      const body = await readBody(req);
      const { profile, package: pkg } = body;
      if (!pkg) return json(res, 400, { error: "package required" });
      const result = installPlugin(profile, pkg);
      return json(res, result.ok ? 200 : 500, result);
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
