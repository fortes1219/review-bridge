// Work-order parser (T0-03 C1). The human file has zero machine fields; sections are
// found by hidden markers, never by heading text. The parser looks only at markers,
// line breaks and whether a reference path exists. It never inspects content.
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

export const WORK_ORDER_SECTIONS = Object.freeze(["name", "product", "version", "work", "acceptance", "references"]);
const REQUIRED = new Set(["name", "work", "acceptance"]);
const MARKER = /<!--\s*rb:([a-z_]+)\s*-->/g;
const MAX_NAME_LENGTH = 120;

// Every string a person can see from this module, in one place for the language pack.
export const MESSAGES = Object.freeze({
  unknown_marker: (key) => "不認識的段落標記：rb:" + key,
  duplicate_marker: (key) => "段落標記重複：rb:" + key,
  missing_section: (key) => "缺少必填段落：" + LABELS[key],
  empty_section: (key) => "必填段落是空的：" + LABELS[key],
  name_one_line: () => "工作名稱只能一行，最多 " + MAX_NAME_LENGTH + " 字",
  single_line: (key) => LABELS[key] + "只能一行",
  reference_missing: (line) => "參考資料裡這條路徑不存在：" + line,
  no_markers: () => "這不是工單檔：找不到任何段落標記，請從 TEMPLATE.md 複製一份再填",
});

export const LABELS = Object.freeze({
  name: "工作名稱",
  product: "產品",
  version: "版本",
  work: "工作內容",
  acceptance: "可驗收條件",
  references: "參考資料",
});

export class WorkOrderError extends Error {
  constructor(problems) {
    super(problems.join("\n"));
    this.name = "WorkOrderError";
    this.problems = problems;
  }
}

export function hasWorkOrderMarkers(text) {
  MARKER.lastIndex = 0;
  return MARKER.test(String(text || ""));
}

function stripDisplayHeadings(block) {
  // The template puts a heading line right after each marker for the person; it is not content.
  return block.split(/\r?\n/).filter((line, index, lines) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#")) return true;
    return lines.slice(0, index).some((previous) => previous.trim() && !previous.trim().startsWith("#"));
  }).join("\n").trim();
}

function nonEmptyLines(block) {
  return block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function looksLikePath(line) {
  const value = line.replace(/^[-*]\s+/, "").trim();
  if (!value || /\s/.test(value)) return null;
  if (!/[\\/.]/.test(value)) return null;
  return value;
}

async function resolveReference(repoRoot, value) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return null;
  const relative = path.posix.normalize(normalized);
  if (relative === ".." || relative.startsWith("../")) return null;
  const absolute = path.resolve(repoRoot, ...relative.split("/"));
  if (!absolute.startsWith(path.resolve(repoRoot) + path.sep) && absolute !== path.resolve(repoRoot)) return null;
  const stat = await fsp.stat(absolute).catch(() => null);
  if (!stat) return null;
  return { path: relative, directory: stat.isDirectory() };
}

const PLAIN_COMMENT = /<!--(?!\s*rb:)[\s\S]*?-->/g;

export function splitSections(text) {
  const source = String(text || "").replace(PLAIN_COMMENT, "");
  const found = [];
  MARKER.lastIndex = 0;
  let match;
  while ((match = MARKER.exec(source)) !== null) {
    found.push({ key: match[1], start: match.index, end: match.index + match[0].length });
  }
  const problems = [];
  const sections = {};
  for (const [index, marker] of found.entries()) {
    const key = marker.key;
    if (!WORK_ORDER_SECTIONS.includes(key)) { problems.push(MESSAGES.unknown_marker(key)); continue; }
    if (key in sections) { problems.push(MESSAGES.duplicate_marker(key)); continue; }
    const next = found[index + 1];
    sections[key] = source.slice(marker.end, next ? next.start : source.length);
  }
  return { sections, problems, markerCount: found.length };
}

// Returns the parsed order or throws WorkOrderError listing every problem at once.
export async function parseWorkOrder(text, { repoRoot }) {
  const { sections, problems, markerCount } = splitSections(text);
  if (markerCount === 0) throw new WorkOrderError([MESSAGES.no_markers()]);
  const blocks = {};
  for (const key of WORK_ORDER_SECTIONS) {
    if (!(key in sections)) {
      if (REQUIRED.has(key)) problems.push(MESSAGES.missing_section(key));
      blocks[key] = "";
      continue;
    }
    blocks[key] = stripDisplayHeadings(sections[key]);
    if (REQUIRED.has(key) && !blocks[key]) problems.push(MESSAGES.empty_section(key));
  }
  const nameLines = nonEmptyLines(blocks.name);
  if (nameLines.length > 1 || (nameLines[0] || "").length > MAX_NAME_LENGTH) problems.push(MESSAGES.name_one_line());
  for (const key of ["product", "version"]) {
    if (nonEmptyLines(blocks[key]).length > 1) problems.push(MESSAGES.single_line(key));
  }
  const references = [];
  for (const line of nonEmptyLines(blocks.references)) {
    const candidate = looksLikePath(line);
    if (!candidate) { references.push({ kind: "text", value: line }); continue; }
    const resolved = await resolveReference(repoRoot, candidate);
    if (!resolved) { problems.push(MESSAGES.reference_missing(line)); continue; }
    references.push({ kind: "path", value: line, path: resolved.path, directory: resolved.directory });
  }
  if (problems.length) throw new WorkOrderError(problems);
  return {
    name: nameLines[0],
    product: nonEmptyLines(blocks.product)[0] || "",
    version: nonEmptyLines(blocks.version)[0] || "",
    work: blocks.work,
    acceptance: nonEmptyLines(blocks.acceptance),
    references,
    source_sha256: createHash("sha256").update(String(text)).digest("hex"),
  };
}
