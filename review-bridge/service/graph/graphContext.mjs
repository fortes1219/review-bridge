// What Bridge itself reads from the project's graph and puts into a prompt, in the shape of aider's repo
// map (knowledge base J; Owner 2026-11-07 02:25: a few hundred tokens may go into the prompt): the model is
// not asked whether to look. The writer gets, before its first call, where the names its work order uses
// are defined, who refers to them, and the files the work order names; or, when it names nothing the graph
// knows, the project's folders and how many files each holds. The reviewer gets, before each review, what
// the changed files define, who refers to those names, who imports the changed files and what they import.
// A fixed number of statements, each through its index, whatever the project's size (graphRecords.mjs);
// one section of at most MAX_CHARS, cut by whole lines with how many were left out. No model is called.
import { definitionsOf, filesNamed, folderOverview, graphState, importers, importsOf, referrers, touched } from "./graphRecords.mjs";

// About 600 tokens: a section is estimated at four characters a token (no tokenizer is loaded for it).
export const MAX_CHARS = 2400;
export const estimateTokens = (text) => Math.ceil(String(text).length / 4);

// One statement asks for all of them: the cost follows this number, not the project.
const MAX_NAMES = 200;
const MAX_FILES = 30;
const posixDir = (file) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".");

// The code the work order marks as code: its `code spans` and fenced blocks, as Markdown parses them
// (markdown-it, the parser VitePress uses and the contract's list is cut with).
async function markedCode(texts) {
  const MarkdownIt = (await import("markdown-it")).default;
  const markdown = new MarkdownIt();
  const code = [];
  for (const text of texts) {
    for (const token of markdown.parse(text, {})) {
      if (token.type === "fence" || token.type === "code_block") code.push(token.content);
      for (const child of token.children ?? []) if (child.type === "code_inline") code.push(child.content);
    }
  }
  return code;
}

function termsIn(text, terms) {
  for (const match of text.matchAll(/[\w.@-]+(?:\/[\w.@-]+)+/g)) terms.paths.add(match[0].replace(/^\.\//, "").replace(/[.,;:]+$/, ""));
  for (const match of text.matchAll(/(?<![\w/.-])[\w-]+\.[A-Za-z][A-Za-z0-9]{0,4}(?![\w/])/g)) terms.fileNames.add(match[0]);
  for (const match of text.matchAll(/[A-Za-z_$][\w$]*/g)) if (match[0].length >= 3) terms.names.add(match[0]);
}

// Identifiers, paths and file names in the work order's words, what it marks as code first, then the rest
// of its text. Which of them the project defines is the graph's answer, so no list of words is kept out.
export async function workOrderTerms(texts) {
  const given = texts.filter(Boolean).map(String);
  const terms = { names: new Set(), paths: new Set(), fileNames: new Set() };
  for (const code of await markedCode(given)) termsIn(code, terms);
  termsIn(given.join("\n"), terms);
  return { names: [...terms.names].slice(0, MAX_NAMES), paths: [...terms.paths].slice(0, MAX_FILES), fileNames: [...terms.fileNames].slice(0, MAX_FILES) };
}

// Lines up to MAX_CHARS, whole lines only; what is left out is counted and pointed to the MCP tools.
export function capLines(heading, lines) {
  const kept = [heading];
  let size = heading.length + 1;
  let index = 0;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (size + line.length + 1 > MAX_CHARS - 80) break;
    kept.push(line);
    size += line.length + 1;
  }
  if (index < lines.length) kept.push("... and " + (lines.length - index) + " more; ask the review-bridge-graph tools for them.");
  return kept.join("\n");
}

const counted = (db) => {
  const wrapped = { queries: 0, query: async (sql, values) => { wrapped.queries += 1; return await db.query(sql, values); } };
  return wrapped;
};

const lineRange = (row) => row.path + ":" + row.start_line + (row.end_line > row.start_line ? "-" + row.end_line : "");

function referenceLines(rows) {
  const byName = new Map();
  for (const row of rows) byName.set(row.name, [...(byName.get(row.name) ?? []), row.path + ":" + row.line]);
  return [...byName].map(([name, places]) => "- " + name + " is referred to at " + places.join(", "));
}

function importerLines(rows) {
  const byTarget = new Map();
  for (const row of rows) byTarget.set(row.target_path, [...(byTarget.get(row.target_path) ?? []), row.path + ":" + row.line]);
  return [...byTarget].map(([target, places]) => "- " + target + " is imported by " + places.join(", "));
}

// The writer's section: { text, queries, tokens }, or null when the project has no graph.
export async function writerGraphContext({ db, projectId, texts }) {
  const sql = counted(db);
  if (!(await graphState(sql, { projectId }))) return null;
  const terms = await workOrderTerms(texts);
  // In the work order's order, what it marks as code first, so the cap cuts the least named last.
  const rank = new Map(terms.names.map((name, index) => [name, index]));
  const byRank = (a, b) => rank.get(a.name) - rank.get(b.name);
  const defined = (await definitionsOf(sql, { projectId, names: terms.names, perName: 3 })).sort(byRank);
  const names = [...new Set(defined.map((row) => row.name))];
  const files = await filesNamed(sql, { projectId, paths: terms.paths, fileNames: terms.fileNames });
  if (!names.length && !files.length) {
    const folders = await folderOverview(sql, { projectId });
    const total = folders[0]?.total ?? 0;
    const text = capLines(
      "Project graph: no name or file in the work order is in the project's index of " + total + " file(s). Its folders, largest first:",
      folders.map((row) => "- " + row.folder + " (" + row.files + " file(s))"),
    );
    return { text, queries: sql.queries, tokens: estimateTokens(text) };
  }
  const referred = names.length ? (await referrers(sql, { projectId, names, perName: 5 })).sort(byRank) : [];
  const targets = [...new Set([...files, ...defined.map((row) => row.path)])].slice(0, MAX_FILES);
  const imported = targets.length ? await importers(sql, { projectId, targets, limit: 40 }) : [];
  const lines = [
    ...defined.map((row) => "- " + row.name + " (" + row.kind + ") is defined at " + lineRange(row)),
    ...files.map((file) => "- the work order names " + file),
    ...referenceLines(referred),
    ...importerLines(imported),
  ];
  const text = capLines("Project graph: where the names and files of this work order are, as Bridge's index of the project has them (references are by name only):", lines);
  return { text, queries: sql.queries, tokens: estimateTokens(text) };
}

// The reviewer's section for the files this review's change touched: { text, queries, tokens }, or null.
export async function reviewerGraphContext({ db, projectId, changedPaths }) {
  const sql = counted(db);
  if (!(await graphState(sql, { projectId }))) return null;
  const paths = [...new Set(changedPaths)].slice(0, MAX_FILES);
  if (!paths.length) return null;
  const changes = paths.map((file) => ({ path: file, start_line: 1, end_line: 2_147_483_647 }));
  const defined = await touched(sql, { projectId, changes, limit: 60 });
  const names = [...new Set(defined.map((row) => row.name))].slice(0, 30);
  const referred = names.length ? await referrers(sql, { projectId, names, perName: 5 }) : [];
  const targets = [...new Set(paths.flatMap((file) => [file, posixDir(file)]).filter((item) => item !== "."))];
  const imported = await importers(sql, { projectId, targets, limit: 40 });
  const outward = await importsOf(sql, { projectId, paths, limit: 60 });
  const lines = [
    ...defined.map((row) => "- " + row.path + " defines " + row.name + " (" + row.kind + ") at " + row.start_line + (row.end_line > row.start_line ? "-" + row.end_line : "")),
    ...referenceLines(referred),
    ...importerLines(imported),
    ...outward.map((row) => "- " + row.path + ":" + row.line + " imports " + row.specifier + (row.target_path ? " (" + row.target_path + ")" : " (" + row.status + ")")),
  ];
  if (!lines.length) {
    const text = capLines("Project graph: none of the changed files is in Bridge's index of the project (a new file, or not code in one of its languages):", paths.map((file) => "- " + file));
    return { text, queries: sql.queries, tokens: estimateTokens(text) };
  }
  const text = capLines("Project graph: what the changed files define, who refers to those names, who imports the changed files and what they import, from Bridge's index of the project at this run's start (references are by name only):", lines);
  return { text, queries: sql.queries, tokens: estimateTokens(text) };
}
