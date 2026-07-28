// Packages the plugin as a distributable .plugin file (a ZIP archive with the
// plugin contents at its root).
//
//   node build/package-plugin.mjs
//
// Written against Node's built-in zlib rather than shelling out, because:
//   - `zip` is not present on a default Windows/Git Bash install
//   - PowerShell's Compress-Archive silently skips dot-prefixed entries, which
//     would drop .claude-plugin/ and .mcp.json — the two most important files
//   - .NET's ZipFile.CreateFromDirectory writes BACKSLASH separators into the
//     archive, which violates the ZIP spec; extractors then fail to find
//     .claude-plugin/plugin.json and the plugin installs with no skills
// Entry names here are always forward-slash separated.

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from "fs";
import { deflateRawSync } from "zlib";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Runtime + metadata only. Tests, build scripts, lockfiles and git metadata are
// deliberately excluded — they are not needed to run the plugin.
const INCLUDE = [
  ".claude-plugin",
  ".mcp.json",
  "skills",
  "lib",
  "server.js",
  "README.md",
  "LICENSE",
  "package.json",
];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// Fixed timestamp so repeated builds of identical input produce identical bytes.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function collect(rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) throw new Error(`missing from plugin source: ${rel}`);
  if (statSync(abs).isDirectory()) {
    return readdirSync(abs).flatMap((child) => collect(`${rel}/${child}`));
  }
  return [rel.replace(/\\/g, "/")];
}

const files = INCLUDE.flatMap(collect).sort();

const locals = [];
const central = [];
let offset = 0;

for (const name of files) {
  const data = readFileSync(join(root, name));
  const crc = crc32(data);
  const deflated = deflateRawSync(data, { level: 9 });
  const useDeflate = deflated.length < data.length;
  const body = useDeflate ? deflated : data;
  const method = useDeflate ? 8 : 0;
  const nameBuf = Buffer.from(name, "utf8");
  const FLAGS = 0x800; // filenames are UTF-8

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(FLAGS, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, nameBuf, body);

  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(20, 4);
  dir.writeUInt16LE(20, 6);
  dir.writeUInt16LE(FLAGS, 8);
  dir.writeUInt16LE(method, 10);
  dir.writeUInt16LE(DOS_TIME, 12);
  dir.writeUInt16LE(DOS_DATE, 14);
  dir.writeUInt32LE(crc, 16);
  dir.writeUInt32LE(body.length, 20);
  dir.writeUInt32LE(data.length, 24);
  dir.writeUInt16LE(nameBuf.length, 28);
  dir.writeUInt16LE(0, 30);
  dir.writeUInt16LE(0, 32);
  dir.writeUInt16LE(0, 34);
  dir.writeUInt16LE(0, 36);
  dir.writeUInt32LE(0, 38);
  dir.writeUInt32LE(offset, 42);
  central.push(dir, nameBuf);

  offset += local.length + nameBuf.length + body.length;
}

const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

const archive = Buffer.concat([...locals, centralBuf, end]);

const name = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8")).name;
mkdirSync(join(root, "dist"), { recursive: true });
const out = join(root, "dist", `${name}.plugin`);
writeFileSync(out, archive);

for (const required of [".claude-plugin/plugin.json", ".mcp.json"]) {
  if (!files.includes(required)) throw new Error(`archive is missing required entry: ${required}`);
}
if (archive.includes(Buffer.from(".claude-plugin\\"))) {
  throw new Error("archive contains backslash separators — extractors will not find nested entries");
}

console.log(`packaged ${files.length} entries -> ${out}  (${(archive.length / 1024).toFixed(0)} KB)\n`);
for (const f of files) console.log(`  ${f}`);
