import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseWorkOrder, WorkOrderError } from "../features/workOrder/workOrderParser.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function workspace(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-work-order-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, "src", "game"), { recursive: true });
  await fsp.writeFile(path.join(root, "src", "game", "farm.js"), "// farm\n");
  await fsp.writeFile(path.join(root, "README.md"), "# demo\n");
  return root;
}

const FULL = `<!-- rb:name -->
# 工作名稱
小型牧場

<!-- rb:product -->
## 產品
akasa

<!-- rb:version -->
## 版本
v2.3

<!-- rb:work -->
## 工作內容
用 babylonJS 做一個小型牧場場景。
有幾棵樹、一片牧草。

<!-- rb:acceptance -->
## 可驗收條件
- 打開頁面會看到牧場
- 方向鍵可以讓農車移動

<!-- rb:references -->
## 參考資料（可略過）
- src/game/farm.js
- 照首頁的做法
src/game/
`;

test("T1 a full order parses into the fixed shape", async (t) => {
  const root = await workspace(t);
  const order = await parseWorkOrder(FULL, { repoRoot: root });
  assert.equal(order.name, "小型牧場");
  assert.equal(order.product, "akasa");
  assert.equal(order.version, "v2.3");
  assert.equal(order.work, "用 babylonJS 做一個小型牧場場景。\n有幾棵樹、一片牧草。");
  assert.deepEqual(order.acceptance, ["- 打開頁面會看到牧場", "- 方向鍵可以讓農車移動"]);
  assert.deepEqual(order.references.map((entry) => [entry.kind, entry.path ?? entry.value]), [
    ["path", "src/game/farm.js"],
    ["text", "- 照首頁的做法"],
    ["path", "src/game"],
  ]);
  assert.equal(order.references[2].directory, true);
  assert.match(order.source_sha256, /^[0-9a-f]{64}$/);
});

test("T2 every problem is reported at once and nothing is accepted", async (t) => {
  const root = await workspace(t);
  const broken = `<!-- rb:name -->
第一行
第二行
<!-- rb:work -->
<!-- rb:acceptance -->

<!-- rb:bogus -->
x
<!-- rb:work -->
again
<!-- rb:references -->
- src/nope.js
`;
  await assert.rejects(parseWorkOrder(broken, { repoRoot: root }), (error) => {
    assert.ok(error instanceof WorkOrderError);
    assert.deepEqual(error.problems, [
      "不認識的段落標記：rb:bogus",
      "段落標記重複：rb:work",
      "必填段落是空的：工作內容",
      "必填段落是空的：可驗收條件",
      "工作名稱只能一行，最多 120 字",
      "參考資料裡這條路徑不存在：- src/nope.js",
    ]);
    return true;
  });
  await assert.rejects(parseWorkOrder("# 沒有標記的檔\n", { repoRoot: root }), /找不到任何段落標記/);
  await assert.rejects(parseWorkOrder("<!-- rb:name -->\nx\n", { repoRoot: root }), (error) => {
    assert.deepEqual(error.problems, ["缺少必填段落：工作內容", "缺少必填段落：可驗收條件"]);
    return true;
  });
});

test("T3 a reference line is a path only when it exists under the workspace", async (t) => {
  const root = await workspace(t);
  const order = await parseWorkOrder(`<!-- rb:name -->
n
<!-- rb:work -->
w
<!-- rb:acceptance -->
a
<!-- rb:references -->
README.md
./src/game/farm.js
C:/Windows/system32
../outside.js
version 1.2.3 of the thing
`, { repoRoot: root }).catch((error) => error);
  assert.ok(order instanceof WorkOrderError);
  assert.deepEqual(order.problems, [
    "參考資料裡這條路徑不存在：C:/Windows/system32",
    "參考資料裡這條路徑不存在：../outside.js",
  ]);
  const ok = await parseWorkOrder(`<!-- rb:name -->
n
<!-- rb:work -->
w
<!-- rb:acceptance -->
a
<!-- rb:references -->
README.md
./src/game/farm.js
version 1.2.3 of the thing
`, { repoRoot: root });
  assert.deepEqual(ok.references.map((entry) => entry.kind), ["path", "path", "text"]);
  assert.equal(ok.references[1].path, "src/game/farm.js");
});

test("T4 content in any language passes untouched; the parser reads only markers", async (t) => {
  const root = await workspace(t);
  const order = await parseWorkOrder(`<!-- rb:name -->
Ферма: небольшая сцена
<!-- rb:work -->
日本語の説明。<b>html</b> は触らない。
<!-- rb:acceptance -->
한 줄이면 충분
`, { repoRoot: root });
  assert.equal(order.name, "Ферма: небольшая сцена");
  assert.equal(order.work, "日本語の説明。<b>html</b> は触らない。");
  assert.deepEqual(order.acceptance, ["한 줄이면 충분"]);
  assert.equal(order.product, "");
  assert.deepEqual(order.references, []);
});

test("T5 heading lines after a marker and the template's hint comment are not content", async (t) => {
  const root = await workspace(t);
  const template = await fsp.readFile(path.join(packageRoot, "project-templates", "work-package.md"), "utf8");
  const order = await parseWorkOrder(template, { repoRoot: root });
  assert.equal(order.name, "小型牧場");
  assert.equal(order.work, "用 babylonJS 做一個小型牧場場景：有幾棵樹、一片牧草、一間放牧草的倉庫、一台農車。");
  assert.equal(order.acceptance.length, 3);
  assert.deepEqual(order.references, []);
  assert.equal(order.product, "");
});
