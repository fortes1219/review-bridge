import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

import { LIST_NAME, parseReleaseList, sha256 } from "./release-list.mjs";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const MAX_EOCD_SEARCH = 65_557;
const REQUIRED_ENTRIES = [
  "bridge.mjs",
  "docs/architecture.mmd",
  "review-bridge/router/index.mjs",
];

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  throw new Error("ZIP end-of-central-directory record is missing or malformed.");
}

export function readZipEntryNames(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new Error("Multi-disk ZIP archives are not supported.");
  }
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported by the release gate.");
  }
  if (centralOffset + centralSize > eocdOffset) {
    throw new Error("ZIP central directory extends beyond its declared boundary.");
  }

  const names = [];
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_FILE_SIGNATURE) {
      throw new Error(`ZIP central-directory entry ${index + 1} is malformed.`);
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) throw new Error(`ZIP entry ${index + 1} has a truncated name.`);
    const name = buffer.toString("utf8", nameStart, nameEnd);
    if (name.includes("\ufffd")) throw new Error(`ZIP entry ${index + 1} has an invalid UTF-8 name.`);
    names.push(name);
    offset = nameEnd + extraLength + commentLength;
  }
  if (offset !== centralOffset + centralSize) {
    throw new Error("ZIP central-directory size does not match its entries.");
  }
  return names;
}

export function validateReleaseEntryNames(names, { requiredEntries = REQUIRED_ENTRIES } = {}) {
  if (!Array.isArray(names) || names.length === 0) throw new Error("Release archive contains no entries.");
  const seen = new Set();
  for (const name of names) {
    if (typeof name !== "string" || name.length === 0) throw new Error("Release archive contains an empty entry name.");
    if (name.includes("\\")) throw new Error(`ZIP entry uses a backslash path separator: ${name}`);
    if (/^[A-Za-z]:/.test(name) || name.startsWith("/") || name.startsWith("//")) {
      throw new Error(`ZIP entry uses an absolute path: ${name}`);
    }
    if (/[\u0000-\u001f\u007f]/u.test(name)) throw new Error(`ZIP entry contains a control character: ${JSON.stringify(name)}`);

    const isDirectory = name.endsWith("/");
    const segments = (isDirectory ? name.slice(0, -1) : name).split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error(`ZIP entry contains an unsafe path segment: ${name}`);
    }
    const collisionKey = name.toLocaleLowerCase("en-US");
    if (seen.has(collisionKey)) throw new Error(`ZIP archive contains a duplicate or case-colliding entry: ${name}`);
    seen.add(collisionKey);
  }

  for (const required of requiredEntries) {
    if (!seen.has(required.toLocaleLowerCase("en-US"))) {
      throw new Error(`Release archive is missing required entry: ${required}`);
    }
  }
  return { ok: true, entries: names.length };
}

// Every entry's name and bytes, read back from the central directory and the local headers.
export function readZipEntries(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_FILE_SIGNATURE) {
      throw new Error(`ZIP central-directory entry ${index + 1} is malformed.`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`ZIP local header of ${name} is malformed.`);
    }
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const stored = buffer.subarray(dataStart, dataStart + compressedSize);
    if (stored.length !== compressedSize) throw new Error(`ZIP entry ${name} is truncated.`);
    let content;
    if (method === 0) content = Buffer.from(stored);
    else if (method === 8) content = inflateRawSync(stored);
    else throw new Error(`ZIP entry ${name} uses an unsupported compression method ${method}.`);
    if (content.length !== size) throw new Error(`ZIP entry ${name} does not have its declared size.`);
    entries.push({ name, content });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// The archive carries exactly the release list's files and the list itself, nothing more or less,
// and each file has the listed sha256. Checking entry names alone does not show this.
export function verifyArchiveAgainstList(buffer, listText) {
  const listed = parseReleaseList(listText);
  const archived = new Map();
  for (const entry of readZipEntries(buffer)) {
    if (archived.has(entry.name)) throw new Error(`Release archive carries ${entry.name} twice.`);
    archived.set(entry.name, entry.content);
  }
  const expected = new Set([LIST_NAME, ...listed.map((entry) => entry.path)]);
  for (const name of archived.keys()) {
    if (!expected.has(name)) throw new Error(`Release archive carries a file the release list does not name: ${name}`);
  }
  for (const name of expected) {
    if (!archived.has(name)) throw new Error(`Release archive is missing a listed file: ${name}`);
  }
  if (archived.get(LIST_NAME).toString("utf8") !== listText) throw new Error("Release archive carries a different release list.");
  for (const entry of listed) {
    if (sha256(archived.get(entry.path)) !== entry.sha256) throw new Error(`Release archive content does not match the release list: ${entry.path}`);
  }
  return { ok: true, entries: archived.size };
}

// Entry names are portable and safe, and the archive matches the release list it carries.
export async function verifyReleaseArchive(file) {
  const buffer = await fsp.readFile(file);
  const names = validateReleaseEntryNames(readZipEntryNames(buffer));
  const list = readZipEntries(buffer).find((entry) => entry.name === LIST_NAME);
  if (!list) throw new Error(`Release archive is missing required entry: ${LIST_NAME}`);
  verifyArchiveAgainstList(buffer, list.content.toString("utf8"));
  return names;
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedAsScript) {
  const archive = process.argv[2];
  if (!archive) {
    process.stderr.write("Usage: node scripts/verify-release-archive.mjs <archive.zip>\n");
    process.exitCode = 2;
  } else {
    try {
      const result = await verifyReleaseArchive(path.resolve(archive));
      process.stdout.write(JSON.stringify(result) + "\n");
    } catch (error) {
      process.stderr.write(`Release archive verification failed: ${error.message}\n`);
      process.exitCode = 2;
    }
  }
}
