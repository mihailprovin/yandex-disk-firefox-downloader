"use strict";
// Guard the publishable source, not the user's local browser profile or logs.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const directories = ["extension", "tests", "scripts", "docs", ".github"];
const files = ["README.md", "PRIVACY.md", "RELEASE-NOTES.md", "package.json", ".gitignore", ".gitattributes"];
function collect(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = directory + "/" + entry.name;
    if (entry.isDirectory()) collect(relative);
    else if (!/\.(zip|xpi)$/i.test(entry.name)) files.push(relative);
  }
}
directories.forEach(collect);
const examples = new Set(["abc", "another", "demo-share", "fixture", "timeout-test", "КОД", "…", "*"]);
for (const file of files) {
  const data = fs.readFileSync(path.join(root, file));
  if (file === "docs/panel.png") {
    assert.equal(data.subarray(1, 4).toString(), "PNG");
    let offset = 8;
    while (offset < data.length) {
      const size = data.readUInt32BE(offset), type = data.subarray(offset + 4, offset + 8).toString();
      assert(["IHDR", "IDAT", "IEND", "sRGB", "gAMA", "cHRM", "pHYs"].includes(type), "Unreviewed PNG metadata: " + type);
      offset += size + 12;
    }
    continue;
  }
  assert(/\.(js|cjs|html|json|md|yml)$/.test(file) || [".gitignore", ".gitattributes"].includes(file), "Unreviewed source file: " + file);
  const text = data.toString("utf8").replaceAll(String.fromCharCode(92) + "n", "\n");
  assert(!/[A-Z]:[/\\]+Users[/\\]+[^/\\\s]+/i.test(text), "Personal Windows path: " + file);
  assert(!/\/(?:home|Users)\/[^/\s]+/.test(text), "Personal home path: " + file);
  assert(!/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text.replaceAll("yandex-disk-clicker@local.codex", "")), "Email address: " + file);
  assert(!/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(text), "Possible credential: " + file);
  const shares = text.matchAll(/https:\/\/(?:disk\.(?:360\.)?yandex\.[a-z.]+|yadi\.sk)\/(?:[di]\/|client\/aa\/d_)([^/\s'"`?<>)}]+)/g);
  for (const share of shares) assert(examples.has(share[1].replace(/[.,;:]+$/, "")), "Non-example public share in " + file);
}
console.log("PASS: publishable source has no personal home paths, email addresses, credential patterns or non-example Disk links; PNG metadata is allowlisted");
