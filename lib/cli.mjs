#!/usr/bin/env node
// dsh-plugin-manager CLI: start the local server and open the GUI in a browser.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const port = Number(process.env.PORT || 5177);
const url = "http://127.0.0.1:" + port;

// start the server in-process
await import("./server.mjs");

// open the browser after a beat
const openCmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
const opener = spawn(openCmd, [url], { shell: true, detached: true, stdio: "ignore" });
opener.unref();
console.log("dsh-plugin-manager GUI:", url);
