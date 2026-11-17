"use strict";

/**
 * Build the installable XPI from extension/ without hard-coding the version.
 * Keeps the filename in sync with manifest.json.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const extensionDir = path.join(root, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
const distDir = path.join(root, "dist");
const target = path.join(distDir, "chatgpt-account-switcher-" + manifest.version + ".xpi");

fs.mkdirSync(distDir, { recursive: true });
fs.rmSync(target, { force: true });

execFileSync("zip", ["-qr", target, ".", "-x", "*.DS_Store"], {
  cwd: extensionDir,
  stdio: "inherit"
});

console.log("Built " + path.relative(root, target));
