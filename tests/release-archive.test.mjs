import assert from "node:assert/strict";
import test from "node:test";

import { readZipEntryNames, validateReleaseEntryNames } from "../scripts/verify-release-archive.mjs";

const validEntries = [
  "bridge.mjs",
  "docs/architecture.mmd",
  "review-bridge/router/index.mjs",
  "review-bridge/templates/PACKAGE_README.md",
];

function storedZip(names) {
  const locals = [];
  const central = [];
  let localOffset = 0;
  let centralSize = 0;
  for (const value of names) {
    const name = Buffer.from(value, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x0314, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(localOffset, 42);
    central.push(entry, name);
    localOffset += local.length + name.length;
    centralSize += entry.length + name.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, ...central, eocd]);
}

test("ZIP-01 release archive accepts portable forward-slash entry paths", () => {
  assert.deepEqual(validateReleaseEntryNames(validEntries), { ok: true, entries: validEntries.length });
});

test("ZIP-02 release archive rejects Windows backslash entry paths", () => {
  assert.throws(
    () => validateReleaseEntryNames(validEntries.map((entry) => entry.replaceAll("/", "\\"))),
    /backslash path separator/,
  );
});

test("ZIP-03 release archive rejects traversal, absolute, and case-colliding entries", () => {
  for (const unsafe of ["../bridge.mjs", "/bridge.mjs", "C:/bridge.mjs"]) {
    assert.throws(
      () => validateReleaseEntryNames([...validEntries, unsafe]),
      /unsafe path segment|absolute path/,
    );
  }
  assert.throws(
    () => validateReleaseEntryNames([...validEntries, "Docs/architecture.mmd"]),
    /case-colliding entry/,
  );
});

test("ZIP-04 central-directory parser rejects a real backslash archive", () => {
  assert.deepEqual(readZipEntryNames(storedZip(validEntries)), validEntries);
  const malformed = validEntries.map((entry) => entry.replaceAll("/", "\\"));
  assert.throws(
    () => validateReleaseEntryNames(readZipEntryNames(storedZip(malformed))),
    /backslash path separator/,
  );
});
