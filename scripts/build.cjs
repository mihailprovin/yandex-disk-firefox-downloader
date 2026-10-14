"use strict";
// Small deterministic ZIP writer using Node's built-in modules. No npm install needed.
const fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib");
const root = path.resolve(__dirname, ".."), source = path.join(root, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("Invalid version");
const table = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const value of data) crc = table[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const chunks = [], central = []; let offset = 0;
const packagedFiles = ["background.js", "common.js", "content.js", "manifest.json", "popup.html", "popup.js", "site.js"];
const entries = packagedFiles.map(name => ({ name, data: fs.readFileSync(path.join(source, name)) }));
for (const entry of entries) {
  const name = Buffer.from(entry.name, "utf8"), data = zlib.deflateRawSync(entry.data), crc = crc32(entry.data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(8, 8); local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26);
  chunks.push(local, name, data);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x800, 8); header.writeUInt16LE(8, 10); header.writeUInt16LE(33, 14);
  header.writeUInt32LE(crc, 16); header.writeUInt32LE(data.length, 20); header.writeUInt32LE(entry.data.length, 24);
  header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42); central.push(header, name);
  offset += local.length + name.length + data.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...chunks, directory, end]);
const output = path.join(root, "dist"); fs.mkdirSync(output, { recursive: true });
for (const extension of ["zip", "xpi"]) {
  const filename = "yandex-disk-firefox-downloader-" + manifest.version + "." + extension;
  fs.writeFileSync(path.join(output, filename), zip); console.log("Built dist/" + filename);
}
