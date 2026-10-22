import assert from "node:assert/strict";
import test from "node:test";

import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkReleasePath, LIST_NAME, sha256 } from "../scripts/release-list.mjs";
import { readZipEntries, readZipEntryNames, validateReleaseEntryNames, verifyArchiveAgainstList } from "../scripts/verify-release-archive.mjs";

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

// The release list (SHA256SUMS.txt) is what a release carries: the packager never regenerates it,
// ships exactly it, and refuses a list that names a private, missing, changed or unsafe path. The
// checksum generator never adds a file by walking the folder and refuses private paths.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE_FILES = [".claude/work-packages/secret-card.md", ".review-bridge/review-queue/runs/run.json"];

// A copy of the package with this working copy's private folders in it, as in the repository.
async function workspaceWithPrivateFolders(t) {
  const copy = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-release-"));
  t.after(() => fsp.rm(copy, { recursive: true, force: true }));
  await fsp.cp(packageRoot, copy, {
    recursive: true,
    filter: (source) => !/[\\/](\.git|node_modules|\.claude|\.review-bridge|\.tmp)([\\/]|$)/.test(source) && !source.endsWith(".zip"),
  });
  for (const relative of PRIVATE_FILES) {
    await fsp.mkdir(path.dirname(path.join(copy, relative)), { recursive: true });
    await fsp.writeFile(path.join(copy, relative), "private\n");
  }
  return copy;
}

function packRelease(copy, output) {
  return spawnSync(process.execPath, [path.join(copy, "scripts", "package-release.mjs"), "--output", output], { cwd: copy, encoding: "utf8", windowsHide: true });
}

function listedPaths(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => line.slice(66));
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("REL-01 packing a workspace with private folders ships exactly the release list, unchanged, and it installs", async (t) => {
  const copy = await workspaceWithPrivateFolders(t);
  const listBefore = await fsp.readFile(path.join(copy, LIST_NAME), "utf8");
  const output = path.join(copy, "..", path.basename(copy) + "-out.zip");
  t.after(() => fsp.rm(output, { force: true }).then(() => fsp.rm(output + ".sha256", { force: true })));
  const packed = packRelease(copy, output);
  assert.equal(packed.status, 0, packed.stderr);
  // The list was checked, not regenerated: the private files did not enter it.
  assert.equal(await fsp.readFile(path.join(copy, LIST_NAME), "utf8"), listBefore);
  const buffer = await fsp.readFile(output);
  const entries = readZipEntries(buffer);
  assert.deepEqual(entries.map((entry) => entry.name).sort(), [LIST_NAME, ...listedPaths(listBefore)].sort());
  assert.equal(entries.some((entry) => /(^|\/)(\.claude|\.review-bridge)(\/|$)/i.test(entry.name)), false);
  assert.deepEqual(verifyArchiveAgainstList(buffer, listBefore), { ok: true, entries: entries.length });
  // Unpacked into a clean folder, the release passes init's integrity check and installs (fake CLI).
  const unpacked = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-unpacked-"));
  const target = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-unpacked-target-"));
  t.after(async () => {
    spawnSync(process.execPath, [path.join(target, ".review-bridge", "tools", "review-bridge", "bootstrap.mjs"), "down"], { cwd: target, windowsHide: true });
    await fsp.rm(unpacked, { recursive: true, force: true });
    await fsp.rm(target, { recursive: true, force: true });
  });
  for (const entry of entries) {
    await fsp.mkdir(path.dirname(path.join(unpacked, entry.name)), { recursive: true });
    await fsp.writeFile(path.join(unpacked, entry.name), entry.content);
  }
  await fsp.writeFile(path.join(target, "package.json"), JSON.stringify({ name: "unpacked-release-target", private: true }) + "\n");
  const init = spawnSync(process.execPath, [path.join(unpacked, "bridge.mjs"), "init", "--target", target, "--writer", "claude", "--reviewer", "codex",
    "--yes", "--json", "--fake-cli", "--port", String(await freePort())], { cwd: unpacked, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(init.status, 0, init.stderr);
  assert.equal(JSON.parse(init.stdout).ok, true);
});

test("REL-02 a list naming a private, missing, changed or unsafe path fails the packing and writes no archive", async (t) => {
  const copy = await workspaceWithPrivateFolders(t);
  const listFile = path.join(copy, LIST_NAME);
  const original = await fsp.readFile(listFile, "utf8");
  const privateLine = sha256(await fsp.readFile(path.join(copy, PRIVATE_FILES[0]))) + "  " + PRIVATE_FILES[0];
  const cases = [
    ["a private path", async () => fsp.writeFile(listFile, original + privateLine + "\n"), /A private path cannot be released: \.claude\/work-packages\/secret-card\.md/],
    ["a private path in other case", async () => fsp.writeFile(listFile, original + privateLine.replace(".claude", ".Claude") + "\n"), /A private path cannot be released/],
    ["a missing file", async () => fsp.writeFile(listFile, original + "0".repeat(64) + "  docs/not-there.md\n"), /A listed file is missing: docs\/not-there\.md/],
    ["a changed file", async () => fsp.appendFile(path.join(copy, "README.md"), "changed\n"), /A listed file does not match its checksum: README\.md/],
    ["a traversal", async () => fsp.writeFile(listFile, original + "0".repeat(64) + "  ../outside.md\n"), /unsafe segment/],
    ["an absolute path", async () => fsp.writeFile(listFile, original + "0".repeat(64) + "  /etc/passwd\n"), /absolute/],
    ["a backslash", async () => fsp.writeFile(listFile, original + "0".repeat(64) + "  docs\\x.md\n"), /backslash/],
  ];
  const readme = await fsp.readFile(path.join(copy, "README.md"));
  for (const [label, damage, reason] of cases) {
    await damage();
    const output = path.join(copy, "..", path.basename(copy) + "-bad.zip");
    const packed = packRelease(copy, output);
    assert.equal(packed.status, 2, label);
    assert.match(packed.stderr, reason, label);
    assert.equal(await fsp.stat(output).then(() => true, () => false), false, label + ": no archive");
    await fsp.writeFile(listFile, original);
    await fsp.writeFile(path.join(copy, "README.md"), readme);
  }
});

test("REL-03 the checksum generator never picks up a file by walking, and refuses private paths", async (t) => {
  const copy = await workspaceWithPrivateFolders(t);
  const listFile = path.join(copy, LIST_NAME);
  const generate = (...args) => spawnSync(process.execPath, [path.join(copy, "scripts", "generate-checksums.mjs"), ...args], { cwd: copy, encoding: "utf8", windowsHide: true });
  const before = listedPaths(await fsp.readFile(listFile, "utf8"));
  assert.equal(generate().status, 0);
  assert.deepEqual(listedPaths(await fsp.readFile(listFile, "utf8")), before, "a refresh adds nothing it finds on disk");
  for (const relative of PRIVATE_FILES) {
    const refused = generate("--add", relative);
    assert.equal(refused.status, 2, relative);
    assert.match(refused.stderr, /A private path cannot be released/);
  }
  assert.deepEqual(listedPaths(await fsp.readFile(listFile, "utf8")), before, "a refused add changes nothing");
  // A file enters only when named, and leaves only when named.
  await fsp.writeFile(path.join(copy, "docs", "added.md"), "added\n");
  assert.equal(generate("--add", "docs/added.md").status, 0);
  assert.ok(listedPaths(await fsp.readFile(listFile, "utf8")).includes("docs/added.md"));
  assert.equal(generate("--remove", "docs/added.md").status, 0);
  assert.deepEqual(listedPaths(await fsp.readFile(listFile, "utf8")), before);
  assert.throws(() => checkReleasePath(LIST_NAME), /cannot name itself/);
});

test("REL-04 the exact comparison refuses an extra, a missing or a changed file, and a different list", () => {
  const files = { "bridge.mjs": "a", "docs/architecture.mmd": "b" };
  const list = Object.entries(files).map(([name, text]) => sha256(Buffer.from(text)) + "  " + name).join("\n") + "\n";
  const zip = (entries) => storedZipWithContent(entries);
  const good = { ...files, [LIST_NAME]: list };
  assert.deepEqual(verifyArchiveAgainstList(zip(good), list), { ok: true, entries: 3 });
  assert.throws(() => verifyArchiveAgainstList(zip({ ...good, ".claude/x.md": "x" }), list), /does not name: \.claude\/x\.md/);
  const { "docs/architecture.mmd": dropped, ...missing } = good;
  assert.throws(() => verifyArchiveAgainstList(zip(missing), list), /missing a listed file: docs\/architecture\.mmd/);
  assert.throws(() => verifyArchiveAgainstList(zip({ ...good, "bridge.mjs": "changed" }), list), /content does not match the release list: bridge\.mjs/);
  assert.throws(() => verifyArchiveAgainstList(zip({ ...good, [LIST_NAME]: list + "\n" }), list), /different release list/);
});

// A stored (uncompressed) ZIP whose entries carry content, for the exact comparison.
function storedZipWithContent(entries) {
  const locals = [];
  const central = [];
  let localOffset = 0;
  let centralSize = 0;
  for (const [value, text] of Object.entries(entries)) {
    const name = Buffer.from(value, "utf8");
    const content = Buffer.from(text, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, content);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x0314, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt32LE(content.length, 20);
    entry.writeUInt32LE(content.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(localOffset, 42);
    central.push(entry, name);
    localOffset += local.length + name.length + content.length;
    centralSize += entry.length + name.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, ...central, eocd]);
}

// Codex review: environment files with real values are never released, at any depth; only the
// placeholder template is.
test("REL-05 .env files are refused at any depth and in any case; .env.example is allowed", async (t) => {
  for (const relative of [".env", "secrets/.env.production", "app/.ENV", "config/.env.local"]) {
    assert.throws(() => checkReleasePath(relative), /An environment file cannot be released/, relative);
  }
  assert.equal(checkReleasePath("config/.env.example"), "config/.env.example");
  // Named for the list, it is refused and the list does not change.
  const copy = await workspaceWithPrivateFolders(t);
  await fsp.mkdir(path.join(copy, "secrets"), { recursive: true });
  await fsp.writeFile(path.join(copy, "secrets", ".env.production"), "API_KEY=real\n");
  const before = await fsp.readFile(path.join(copy, LIST_NAME), "utf8");
  const refused = spawnSync(process.execPath, [path.join(copy, "scripts", "generate-checksums.mjs"), "--add", "secrets/.env.production"], { cwd: copy, encoding: "utf8", windowsHide: true });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /An environment file cannot be released: secrets\/\.env\.production/);
  assert.equal(await fsp.readFile(path.join(copy, LIST_NAME), "utf8"), before);
});

// Codex review: a folder that is a link or a junction (docs/alias -> .claude) must not carry private
// files in under an innocent name. Every step of a listed path is checked, not only the last.
test("REL-06 a listed path through a folder link or junction is refused by the generator and the packer", async (t) => {
  const copy = await workspaceWithPrivateFolders(t);
  const alias = path.join(copy, "docs", "alias");
  try {
    await fsp.symlink(path.join(copy, ".claude"), alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    return t.skip("this machine cannot make a folder link here (" + error.code + ")");
  }
  const smuggled = "docs/alias/work-packages/secret-card.md";
  assert.equal(await fsp.readFile(path.join(copy, ...smuggled.split("/")), "utf8"), "private\n", "the link really reaches the private file");
  const refused = spawnSync(process.execPath, [path.join(copy, "scripts", "generate-checksums.mjs"), "--add", smuggled], { cwd: copy, encoding: "utf8", windowsHide: true });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /A listed path goes through a link: docs\/alias/);
  // Written into the list by hand, the packer refuses it and writes no archive.
  const listFile = path.join(copy, LIST_NAME);
  await fsp.appendFile(listFile, sha256(Buffer.from("private\n")) + "  " + smuggled + "\n");
  const output = path.join(copy, "..", path.basename(copy) + "-link.zip");
  const packed = packRelease(copy, output);
  assert.equal(packed.status, 2);
  assert.match(packed.stderr, /A listed path goes through a link: docs\/alias/);
  assert.equal(await fsp.stat(output).then(() => true, () => false), false);
});
