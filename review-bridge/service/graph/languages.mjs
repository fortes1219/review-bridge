// The nine languages the graph reads (Owner 2026-11-08) and what each grammar says a definition, a
// reference and an import are. Definitions and references follow each grammar's own queries/tags.scm,
// the code-navigation convention of tree-sitter (docs/src/4-code-navigation.md) that aider's repo map
// reads: the same node kinds and the same name child. JavaScript and TypeScript add Bridge's own lines, as
// aider carries query files of its own: module-level constants and variables, type aliases, enums and
// their members, in the kinds of universal-ctags' TypeScript parser and LSP's SymbolKind (Fortes
// 2026-11-09). Other languages keep their grammar's tags.scm until each gets its ctags parser's kinds;
// where it has no line (Java enums, C# structs, any C++ reference) the graph has none either. Imports are
// the node kinds each grammar's node-types.json gives for its import statement.
// The tags.scm versions read are listed in .claude/docs/ECOSYSTEM-REFERENCES.md (2026-11-09).

// JavaScript, TypeScript and TSX come with @ast-grep/napi; the other six are @ast-grep/lang-* packages,
// installed when a project needs them (grammars.mjs), at these versions only.
export const BUILT_IN = Object.freeze({ javascript: "JavaScript", typescript: "TypeScript", tsx: "Tsx" });
export const LANGUAGE_PACKAGES = Object.freeze({
  python: "@ast-grep/lang-python@0.0.6",
  go: "@ast-grep/lang-go@0.0.6",
  rust: "@ast-grep/lang-rust@0.0.7",
  java: "@ast-grep/lang-java@0.0.7",
  kotlin: "@ast-grep/lang-kotlin@0.0.7",
  cpp: "@ast-grep/lang-cpp@0.0.6",
  csharp: "@ast-grep/lang-csharp@0.0.6",
});

// By extension; anything else is not read and not reported. `.jsx` is read with the TSX grammar: the
// JavaScript grammar reads `class="` in JSX as an error (measured 2026-11-09). `.h` is read as C++, the
// one C-family language of the nine. `.vue` is split by @vue/compiler-sfc first (vueBlocks).
const EXTENSIONS = Object.freeze({
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "tsx",
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx",
  ".vue": "vue",
  ".py": "python", ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin", ".kts": "kotlin",
  ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".c++": "cpp", ".hpp": "cpp", ".hh": "cpp", ".hxx": "cpp", ".h": "cpp",
  ".cs": "csharp",
});

export function languageOf(file) {
  const dot = file.lastIndexOf(".");
  const slash = file.lastIndexOf("/");
  return dot > slash ? EXTENSIONS[file.slice(dot).toLowerCase()] ?? null : null;
}

// The grammar a parsed language needs: a .vue file needs the ones its script blocks are written in.
export const grammarOf = (language) => (language === "vue" ? "typescript" : language);

const lineOf = (node) => node.range().start.line + 1;
const textOf = (node) => (node ? node.text() : null);
const unquote = (text) => text.replace(/^(['"`])([\s\S]*)\1$/, "$2");
const childOf = (node, kinds) => node.children().find((child) => kinds.includes(child.kind())) ?? null;
const childrenOf = (node, kinds) => node.children().filter((child) => kinds.includes(child.kind()));

function definition(out, node, nameNode, kind) {
  const name = textOf(nameNode);
  if (!name) return;
  const range = node.range();
  out.definitions.push({ name, kind, start_line: range.start.line + 1, end_line: range.end.line + 1 });
}
function reference(out, nameNode, kind) {
  const name = textOf(nameNode);
  if (name) out.references.push({ name, kind, line: lineOf(nameNode) });
}
const importOf = (out, node, specifier, form = "import") => {
  if (specifier) out.imports.push({ specifier, line: lineOf(node), form });
};
const FUNCTION_VALUES = ["arrow_function", "function_expression", "function"];

// tree-sitter-javascript v0.25.0 queries/tags.scm.
const JAVASCRIPT = {
  method_definition(node, out) {
    const name = node.field("name");
    if (textOf(name) !== "constructor") definition(out, node, name, "method");
  },
  class(node, out) { definition(out, node, node.field("name"), "class"); },
  class_declaration(node, out) { definition(out, node, node.field("name"), "class"); },
  function_expression(node, out) { definition(out, node, node.field("name"), "function"); },
  function_declaration(node, out) { definition(out, node, node.field("name"), "function"); },
  generator_function(node, out) { definition(out, node, node.field("name"), "function"); },
  generator_function_declaration(node, out) { definition(out, node, node.field("name"), "function"); },
  // A function value is a function wherever it is declared (tags.scm). Any other value declared at the
  // module's top level, exported or not, is a constant (const) or a variable (let, var): Bridge's own
  // query set, in the kinds of universal-ctags' TypeScript parser and LSP's SymbolKind, as aider carries
  // query files of its own (knowledge base J, 2026-11-09). A destructuring pattern names no one thing.
  variable_declarator(node, out) {
    const name = node.field("name");
    const declaration = node.parent();
    if (name?.kind() !== "identifier" || !["lexical_declaration", "variable_declaration"].includes(declaration?.kind())) return;
    if (FUNCTION_VALUES.includes(node.field("value")?.kind())) return definition(out, node, name, "function");
    if (!moduleLevel(declaration)) return;
    const constant = declaration.kind() === "lexical_declaration" && declaration.children()[0]?.text() === "const";
    definition(out, declaration.parent()?.kind() === "export_statement" ? declaration.parent() : declaration, name, constant ? "constant" : "variable");
  },
  assignment_expression(node, out) {
    if (!FUNCTION_VALUES.includes(node.field("right")?.kind())) return;
    const left = node.field("left");
    if (left?.kind() === "identifier") definition(out, node, left, "function");
    else if (left?.kind() === "member_expression") definition(out, node, left.field("property"), "function");
  },
  pair(node, out) {
    const key = node.field("key");
    if (key?.kind() === "property_identifier" && FUNCTION_VALUES.includes(node.field("value")?.kind())) definition(out, node, key, "function");
  },
  call_expression(node, out) {
    const callee = node.field("function");
    const args = node.field("arguments");
    if (callee?.kind() === "identifier") {
      // require("x") and import("x") are imports, not calls (tags.scm: #not-match? @name "^(require)$").
      if (callee.text() === "require") importOf(out, node, stringArgument(args), "require");
      else reference(out, callee, "call");
    } else if (callee?.kind() === "import") importOf(out, node, stringArgument(args), "dynamic");
    else if (callee?.kind() === "member_expression") reference(out, callee.field("property"), "call");
  },
  new_expression(node, out) {
    const constructor = node.field("constructor");
    if (constructor?.kind() === "identifier") reference(out, constructor, "class");
  },
  export_statement(node, out) {
    const value = node.field("value");
    if (value?.kind() === "assignment_expression" && value.field("left")?.kind() === "identifier") definition(out, node, value.field("left"), "constant");
    importOf(out, node, stringValue(node.field("source")), "export");
  },
  import_statement(node, out) { importOf(out, node, stringValue(node.field("source"))); },
};
// The module's top level: the program itself, or an `export` directly under it (a .vue script block is
// its own program, so its top level is the same).
function moduleLevel(declaration) {
  const parent = declaration.parent();
  return parent?.kind() === "program" || (parent?.kind() === "export_statement" && parent.parent()?.kind() === "program");
}

function stringValue(node) {
  return node && node.kind() === "string" ? unquote(node.text()) : null;
}
function stringArgument(args) {
  const first = args?.children().find((child) => child.isNamed());
  return first?.kind() === "string" ? unquote(first.text()) : null;
}

// tree-sitter-typescript v0.23.2 queries/tags.scm, which both grammars read on top of JavaScript's.
const TYPESCRIPT = {
  ...JAVASCRIPT,
  function_signature(node, out) { definition(out, node, node.field("name"), "function"); },
  method_signature(node, out) { definition(out, node, node.field("name"), "method"); },
  abstract_method_signature(node, out) { definition(out, node, node.field("name"), "method"); },
  abstract_class_declaration(node, out) { definition(out, node, node.field("name"), "class"); },
  module(node, out) { definition(out, node, node.field("name"), "module"); },
  interface_declaration(node, out) { definition(out, node, node.field("name"), "interface"); },
  type_annotation(node, out) { reference(out, childOf(node, ["type_identifier"]), "type"); },
  // Bridge's own (ctags' alias, enum and enumerator; aider's typescript-tags.scm has the first two).
  type_alias_declaration(node, out) { definition(out, node, node.field("name"), "alias"); },
  enum_declaration(node, out) {
    definition(out, node, node.field("name"), "enum");
    const body = node.field("body") ?? childOf(node, ["enum_body"]);
    for (const member of body ? body.children() : []) {
      if (member.kind() === "property_identifier") definition(out, member, member, "enumerator");
      else if (member.kind() === "enum_assignment") definition(out, member, member.field("name") ?? childOf(member, ["property_identifier"]), "enumerator");
    }
  },
  import_require_clause(node, out) { importOf(out, node, stringValue(node.field("source")), "require"); },
};

// tree-sitter-python v0.25.0.
const PYTHON = {
  class_definition(node, out) { definition(out, node, node.field("name"), "class"); },
  function_definition(node, out) { definition(out, node, node.field("name"), "function"); },
  assignment(node, out) {
    const left = node.field("left");
    if (left?.kind() === "identifier" && node.parent()?.kind() === "expression_statement" && node.parent().parent()?.kind() === "module") definition(out, node, left, "constant");
  },
  call(node, out) {
    const callee = node.field("function");
    if (callee?.kind() === "identifier") reference(out, callee, "call");
    else if (callee?.kind() === "attribute") reference(out, callee.field("attribute"), "call");
  },
  import_statement(node, out) {
    for (const name of node.children().filter((child) => ["dotted_name", "aliased_import"].includes(child.kind()))) {
      importOf(out, node, textOf(name.kind() === "aliased_import" ? name.field("name") : name));
    }
  },
  import_from_statement(node, out) { importOf(out, node, textOf(node.field("module_name"))); },
};

// tree-sitter-go v0.25.0.
const GO = {
  function_declaration(node, out) { definition(out, node, node.field("name"), "function"); },
  method_declaration(node, out) { definition(out, node, node.field("name"), "method"); },
  type_spec(node, out) { definition(out, node, node.field("name"), "type"); },
  call_expression(node, out) {
    const callee = node.field("function");
    if (callee?.kind() === "identifier") reference(out, callee, "call");
    else if (callee?.kind() === "selector_expression") reference(out, callee.field("field"), "call");
  },
  type_identifier(node, out) { reference(out, node, "type"); },
  import_spec(node, out) { importOf(out, node, unquote(textOf(node.field("path")) ?? "") || null); },
  package_clause(node, out) { out.package ??= textOf(childOf(node, ["package_identifier"])); },
};

// tree-sitter-rust v0.24.2 (the version that puts the method's capture on the function item).
const RUST = {
  struct_item(node, out) { definition(out, node, node.field("name"), "class"); },
  enum_item(node, out) { definition(out, node, node.field("name"), "class"); },
  union_item(node, out) { definition(out, node, node.field("name"), "class"); },
  type_item(node, out) { definition(out, node, node.field("name"), "class"); },
  function_item(node, out) { definition(out, node, node.field("name"), node.parent()?.kind() === "declaration_list" ? "method" : "function"); },
  trait_item(node, out) { definition(out, node, node.field("name"), "interface"); },
  mod_item(node, out) {
    definition(out, node, node.field("name"), "module");
    // A module without a body is loaded from a file (Rust Reference, items.mod.outlined).
    if (!node.field("body")) importOf(out, node, textOf(node.field("name")), "mod");
  },
  macro_definition(node, out) { definition(out, node, node.field("name"), "macro"); },
  call_expression(node, out) {
    const callee = node.field("function");
    if (callee?.kind() === "identifier") reference(out, callee, "call");
    else if (callee?.kind() === "field_expression") reference(out, callee.field("field"), "call");
    else if (callee?.kind() === "scoped_identifier") reference(out, callee.field("name"), "call");
  },
  macro_invocation(node, out) { reference(out, node.field("macro"), "call"); },
  impl_item(node, out) { reference(out, node.field("trait") ?? node.field("type"), "implementation"); },
  use_declaration(node, out) { importOf(out, node, textOf(node.field("argument")), "use"); },
};

// tree-sitter-java v0.23.5.
const JAVA = {
  class_declaration(node, out) { definition(out, node, node.field("name"), "class"); },
  method_declaration(node, out) { definition(out, node, node.field("name"), "method"); },
  interface_declaration(node, out) { definition(out, node, node.field("name"), "interface"); },
  method_invocation(node, out) { reference(out, node.field("name"), "call"); },
  type_list(node, out) { for (const type of childrenOf(node, ["type_identifier"])) reference(out, type, "implementation"); },
  object_creation_expression(node, out) { reference(out, node.field("type"), "class"); },
  superclass(node, out) { reference(out, childOf(node, ["type_identifier"]), "class"); },
  import_declaration(node, out) {
    const name = textOf(childOf(node, ["scoped_identifier", "identifier"]));
    importOf(out, node, name && (childOf(node, ["asterisk"]) ? name + ".*" : name), node.children().some((child) => child.text() === "static") ? "static" : "import");
  },
  package_declaration(node, out) { out.package ??= textOf(childOf(node, ["scoped_identifier", "identifier"])); },
};

// fwcd/tree-sitter-kotlin main queries/tags.scm (b4cc392); the 0.3.8 grammar lang-kotlin 0.0.7 pins has
// the same node kinds and no fields, so names are children.
const KOTLIN = {
  class_declaration(node, out) { definition(out, node, childOf(node, ["type_identifier"]), "class"); },
  object_declaration(node, out) { definition(out, node, childOf(node, ["type_identifier"]), "class"); },
  function_declaration(node, out) { definition(out, node, childOf(node, ["simple_identifier"]), "function"); },
  type_alias(node, out) { definition(out, node, childOf(node, ["type_identifier"]), "type"); },
  property_declaration(node, out) {
    const variable = childOf(node, ["variable_declaration"]);
    if (variable) definition(out, node, childOf(variable, ["simple_identifier"]), "constant");
  },
  call_expression(node, out) {
    const callee = node.children()[0];
    if (callee?.kind() === "simple_identifier") reference(out, callee, "call");
    else if (callee?.kind() === "navigation_expression") {
      const suffix = childrenOf(callee, ["navigation_suffix"]).at(-1);
      if (suffix) reference(out, childOf(suffix, ["simple_identifier"]), "call");
    }
  },
  constructor_invocation(node, out) {
    const type = childOf(node, ["user_type"]);
    if (type) reference(out, childOf(type, ["type_identifier"]), "class");
  },
  import_header(node, out) { importOf(out, node, textOf(childOf(node, ["identifier"]))); },
  package_header(node, out) { out.package ??= textOf(childOf(node, ["identifier"])); },
};

// tree-sitter-c-sharp v0.23.5 (its invocation kind is `send`, as its tags.scm names it).
const CSHARP = {
  class_declaration(node, out) {
    definition(out, node, node.field("name"), "class");
    const bases = childOf(node, ["base_list"]);
    if (bases) for (const base of bases.children().filter((child) => child.isNamed())) reference(out, base, "class");
  },
  interface_declaration(node, out) {
    definition(out, node, node.field("name"), "interface");
    const bases = childOf(node, ["base_list"]);
    if (bases) for (const base of bases.children().filter((child) => child.isNamed())) reference(out, base, "interface");
  },
  method_declaration(node, out) { definition(out, node, node.field("name"), "method"); },
  namespace_declaration(node, out) {
    definition(out, node, node.field("name"), "module");
    out.package ??= textOf(node.field("name"));
  },
  file_scoped_namespace_declaration(node, out) { out.package ??= textOf(node.field("name")); },
  object_creation_expression(node, out) { reference(out, node.field("type"), "class"); },
  variable_declaration(node, out) {
    const type = node.field("type");
    if (type && type.kind() !== "implicit_type") reference(out, type, "class");
  },
  invocation_expression(node, out) {
    const callee = node.field("function");
    if (callee?.kind() === "member_access_expression") reference(out, callee.field("name"), "send");
  },
  using_directive(node, out) {
    if (node.field("name")) return; // `using X = T;` names an alias, not a namespace
    importOf(out, node, textOf(childOf(node, ["qualified_name", "identifier"])));
  },
};

// tree-sitter-cpp v0.23.4: definitions only; its tags.scm has no reference.
const CPP = {
  struct_specifier(node, out) { if (node.field("body")) definition(out, node, node.field("name"), "class"); },
  class_specifier(node, out) { definition(out, node, node.field("name"), "class"); },
  union_specifier(node, out) { if (node.parent()?.kind() === "declaration") definition(out, node, node.field("name"), "class"); },
  function_declarator(node, out) {
    const declarator = node.field("declarator");
    if (["identifier", "field_identifier"].includes(declarator?.kind())) definition(out, node, declarator, "function");
    else if (declarator?.kind() === "qualified_identifier") definition(out, node, declarator.field("name"), "method");
  },
  type_definition(node, out) { definition(out, node, node.field("declarator"), "type"); },
  enum_specifier(node, out) { definition(out, node, node.field("name"), "type"); },
  preproc_include(node, out) {
    const target = node.field("path");
    if (target?.kind() === "string_literal") importOf(out, node, unquote(target.text()), "quote");
    else if (target?.kind() === "system_lib_string") importOf(out, node, target.text().slice(1, -1), "system");
  },
};

export const RULES = Object.freeze({
  javascript: JAVASCRIPT, typescript: TYPESCRIPT, tsx: TYPESCRIPT,
  python: PYTHON, go: GO, rust: RUST, java: JAVA, kotlin: KOTLIN, csharp: CSHARP, cpp: CPP,
});
