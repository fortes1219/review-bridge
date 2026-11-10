// One file's part of the graph: what it defines, which names it refers to, its import strings, the
// package it declares, and how many ERROR nodes its parse holds. One walk per file: every node kind the
// language's rules name is found in a single findAll, and each rule reads its node.
import { BUILT_IN, RULES } from "./languages.mjs";

const ERROR = { rule: { kind: "ERROR" } };
const matchers = new Map();
function matcherFor(language) {
  if (!matchers.has(language)) matchers.set(language, { rule: { any: Object.keys(RULES[language]).map((kind) => ({ kind })) } });
  return matchers.get(language);
}

const empty = () => ({ definitions: [], references: [], imports: [], package: null, error_count: 0 });

// `grammar` is the language's name as registered (built-in names are napi's own). Lines are 1-based and
// moved by `lineOffset`, which a .vue script block needs.
export async function extractSource(napi, language, source, { lineOffset = 0, out = empty() } = {}) {
  const root = (await napi.parseAsync(BUILT_IN[language] ?? language, source)).root();
  const rules = RULES[language];
  const part = empty();
  for (const node of root.findAll(matcherFor(language))) rules[node.kind()]?.(node, part);
  part.error_count = root.findAll(ERROR).length;
  for (const item of part.definitions) out.definitions.push({ ...item, start_line: item.start_line + lineOffset, end_line: item.end_line + lineOffset });
  for (const item of part.references) out.references.push({ ...item, line: item.line + lineOffset });
  for (const item of part.imports) out.imports.push({ ...item, line: item.line + lineOffset });
  out.package ??= part.package;
  out.error_count += part.error_count;
  return out;
}

// A .vue file: Vue's own compiler-sfc finds its <script> and <script setup> blocks and their lines;
// each is read in the language its `lang` names (ts, tsx; jsx is read as TSX, as a .jsx file is). Its
// template is not read: whether a component tag counts as a reference is not settled (knowledge base,
// to-check 14). A block compiler-sfc cannot split counts as one error.
const VUE_LANG = { ts: "typescript", tsx: "tsx", jsx: "tsx", js: "javascript", undefined: "javascript" };

export async function extractVue(napi, source, { parse = null } = {}) {
  const sfc = parse ?? (await import("@vue/compiler-sfc")).parse;
  const { descriptor, errors } = sfc(source, { sourceMap: false, ignoreEmpty: true });
  const out = empty();
  out.error_count += errors.length;
  for (const block of [descriptor.script, descriptor.scriptSetup].filter(Boolean)) {
    const language = VUE_LANG[block.lang] ?? null;
    if (!language) { out.error_count += 1; continue; }
    await extractSource(napi, language, block.content, { lineOffset: block.loc.start.line - 1, out });
  }
  return out;
}

export async function extractFile(napi, language, source) {
  return language === "vue" ? await extractVue(napi, source) : await extractSource(napi, language, source);
}
