import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import { generateChecksumManifest } from "./generate-checksums.mjs";
import { verifyReleaseArchive } from "./verify-release-archive.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exportsRoot = path.dirname(packageRoot);
const excludedDirectories = new Set(["node_modules", ".git", ".tmp"]);
const UTF8_FLAG = 0x0800;
const DEFLATE_METHOD = 8;
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

async function collectFiles(directory, relative = "") {
  const output = [];
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Package source cannot contain a symlink: ${path.posix.join(relative, entry.name)}`);
    const nextRelative = path.posix.join(relative, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) output.push(...await collectFiles(absolute, nextRelative));
    } else if (entry.isFile() && !entry.name.endsWith(".zip") && !entry.name.endsWith(".sha256")) {
      output.push({ absolute, relative: nextRelative });
    }
  }
  return output;
}

function makeLocalHeader(entry) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(DEFLATE_METHOD, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressed.length, 18);
  header.writeUInt32LE(entry.content.length, 22);
  header.writeUInt16LE(entry.name.length, 26);
  return header;
}

function makeCentralHeader(entry) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(DEFLATE_METHOD, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressed.length, 20);
  header.writeUInt32LE(entry.content.length, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  header.writeUInt32LE(entry.localOffset, 42);
  return header;
}

async function createZip(files) {
  if (files.length === 0 || files.length > 0xffff) throw new Error("Release file count is outside classic ZIP limits.");
  const localParts = [];
  const entries = [];
  let localOffset = 0;

  for (const file of files) {
    if (file.relative.includes("\\") || file.relative.startsWith("/") || file.relative.split("/").some((part) => part === "..")) {
      throw new Error(`Unsafe release entry path: ${file.relative}`);
    }
    const name = Buffer.from(file.relative, "utf8");
    const content = await fsp.readFile(file.absolute);
    const compressed = deflateRawSync(content, { level: 9 });
    const entry = { name, content, compressed, crc: crc32(content), localOffset };
    const header = makeLocalHeader(entry);
    localParts.push(header, name, compressed);
    localOffset += header.length + name.length + compressed.length;
    if (localOffset > 0xffffffff) throw new Error("Release archive exceeds classic ZIP size limits.");
    entries.push(entry);
  }

  const centralParts = [];
  let centralSize = 0;
  for (const entry of entries) {
    const header = makeCentralHeader(entry);
    centralParts.push(header, entry.name);
    centralSize += header.length + entry.name.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function parseArguments(argv) {
  const args = { output: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output" && argv[index + 1]) args.output = argv[++index];
    else throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
  }
  return args;
}

const args = parseArguments(process.argv.slice(2));
const packageJson = JSON.parse(await fsp.readFile(path.join(packageRoot, "package.json"), "utf8"));
const defaultName = `codex-review-bridge-installer-${packageJson.version}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}.zip`;
const destination = path.resolve(args.output || path.join(exportsRoot, defaultName));
const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;

try {
  await generateChecksumManifest(packageRoot);
  const files = await collectFiles(packageRoot);
  const archive = await createZip(files);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.writeFile(temporary, archive, { flag: "wx" });
  const verified = await verifyReleaseArchive(temporary);

  await fsp.rm(destination, { force: true });
  await fsp.rename(temporary, destination);
  const digest = createHash("sha256").update(archive).digest("hex");
  await fsp.writeFile(`${destination}.sha256`, `${digest}  ${path.basename(destination)}\n`, "utf8");
  process.stdout.write(JSON.stringify({ ok: true, archive: destination, entries: verified.entries }) + "\n");
} catch (error) {
  await fsp.rm(temporary, { force: true }).catch(() => {});
  process.stderr.write(`Release packaging failed: ${error.message}\n`);
  process.exitCode = 2;
}
