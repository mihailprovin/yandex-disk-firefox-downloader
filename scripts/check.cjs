"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const directory = path.join(root, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (manifest.version !== pkg.version) throw new Error("Manifest/package version mismatch");
for (const name of manifest.background.scripts.concat(manifest.content_scripts.flatMap(x => x.js), ["popup.js", "popup.html"])) {
  if (!fs.existsSync(path.join(directory, name))) throw new Error("Missing extension file: " + name);
}
for (const file of fs.readdirSync(directory).filter(x => x.endsWith(".js"))) {
  const result = spawnSync(process.execPath, ["--check", path.join(directory, file)], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
if (manifest.manifest_version !== 2) throw new Error("This build requires Firefox MV2");
console.log("PASS: manifest, package version, extension assets and JavaScript syntax");
