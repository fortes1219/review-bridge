// Where each import string leads. Bridge writes no resolution rule of its own: JavaScript and TypeScript
// go through oxc-resolver, the resolver Vite 8 reaches through rolldown, with rolldown's and Vite's
// options; every other language uses only what its own documentation says a path is (knowledge base,
// 2026-11-09): Python's import system with Pyright's roots, Go's module path, Rust's module files, javac's
// package-mirrors-directory rule, the first step of GCC's quote-include search. Kotlin and C# have no
// path rule, so their strings are kept and marked unresolved. Only the file system is read.
//   resolved   the file (or, for Go and Java wildcards, the directory) in the project
//   external   outside the project: node_modules, a built-in, or a module no project root has
//   unresolved a string Bridge cannot place by those rules
import fsp from "node:fs/promises";
import path from "node:path";

const posix = (file) => file.split(path.sep).join("/");

export function createResolver({ projectRoot, folders = [""] }) {
  const root = path.resolve(projectRoot);
  const stats = new Map();
  const stat = (file) => {
    if (!stats.has(file)) stats.set(file, fsp.stat(file).then((value) => (value.isDirectory() ? "dir" : "file"), () => null));
    return stats.get(file);
  };
  const isFile = async (file) => (await stat(file)) === "file";
  const isDir = async (file) => (await stat(file)) === "dir";
  const relative = (absolute) => posix(path.relative(root, absolute));
  const inModules = (absolute) => absolute.split(/[\\/]/).includes("node_modules");
  const found = (absolute, kind = "file") => (inModules(absolute) ? { status: "external" } : { status: "resolved", target_path: relative(absolute), target_kind: kind });
  const UNRESOLVED = { status: "unresolved" };
  const EXTERNAL = { status: "external" };
  // The scope folder a file is in (the longest that holds it).
  const folderOf = (file) => folders.filter((dir) => dir === "" || file === dir || file.startsWith(dir + "/")).sort((a, b) => b.length - a.length)[0] ?? "";

  let oxc = null;
  async function javascript(file, specifier) {
    if (!oxc) {
      const { ResolverFactory } = await import("oxc-resolver");
      // rolldown_plugin_vite_resolve: extension_alias .js -> .js/.ts/.tsx, node_path off, resolve_file
      // with tsconfig discovery; Vite's default extensions, conditions and main fields, plus .vue, a file
      // the graph reads.
      oxc = new ResolverFactory({
        extensions: [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json", ".vue", ".node"],
        extensionAlias: { ".js": [".js", ".ts", ".tsx"], ".mjs": [".mjs", ".mts"], ".cjs": [".cjs", ".cts"] },
        conditionNames: ["import", "module", "browser", "node", "development", "default", "require"],
        mainFields: ["browser", "module", "jsnext:main", "jsnext", "main"],
        nodePath: false,
        tsconfig: "auto",
        // Node's own modules ("fs", "node:fs") come back as `builtin`, outside the project.
        builtinModules: true,
      });
    }
    const result = oxc.resolveFileSync(path.join(root, file), specifier);
    if (result.builtin) return EXTERNAL;
    // A package that is not installed, or an alias only a vite.config defines, is not told apart: both
    // are a string oxc-resolver cannot place.
    return result.path ? found(result.path) : UNRESOLVED;
  }

  // Python: relative imports from the file's package; absolute ones from the project roots Pyright uses
  // (the folder, then its src/ when src/ is no package), each tried as FileFinder does: a package's
  // __init__, then the module file.
  const pythonRoots = new Map();
  async function rootsOf(folder) {
    if (!pythonRoots.has(folder)) {
      const base = path.join(root, folder);
      const src = path.join(base, "src");
      const roots = [base];
      if (await isDir(src) && !(await isFile(path.join(src, "__init__.py")))) roots.push(src);
      pythonRoots.set(folder, roots);
    }
    return pythonRoots.get(folder);
  }
  async function pythonModule(base, parts) {
    const target = path.join(base, ...parts);
    for (const candidate of [path.join(target, "__init__.py"), path.join(target, "__init__.pyi"), target + ".py", target + ".pyi"]) {
      if (await isFile(candidate)) return candidate;
    }
    return null;
  }
  async function python(file, specifier) {
    const dots = specifier.match(/^\.*/)[0].length;
    const parts = specifier.slice(dots).split(".").filter(Boolean);
    if (dots) {
      let base = path.dirname(path.join(root, file));
      for (let level = 1; level < dots; level += 1) base = path.dirname(base);
      const target = await pythonModule(base, parts);
      return target ? found(target) : UNRESOLVED;
    }
    for (const base of await rootsOf(folderOf(file))) {
      const target = await pythonModule(base, parts);
      if (target) return found(target);
    }
    // The standard library and installed packages are not in the project; without them, a module the
    // roots do not hold cannot be told apart from a missing one.
    return UNRESOLVED;
  }

  // Go: the nearest go.mod's module path; an import under it is that directory of the module. The
  // folders are walked up one by one, each answer kept for the folders below it.
  const modules = new Map();
  async function goModule(start) {
    const walked = [];
    let module = null;
    for (let dir = start; ; dir = path.dirname(dir)) {
      if (modules.has(dir)) { module = modules.get(dir); break; }
      walked.push(dir);
      const text = await fsp.readFile(path.join(dir, "go.mod"), "utf8").catch(() => null);
      const name = text?.match(/^\s*module\s+("?)([^\s"]+)\1/m)?.[2];
      if (name) { module = { dir, name }; break; }
      if (path.dirname(dir) === dir) break;
    }
    for (const dir of walked) modules.set(dir, module);
    return module;
  }
  async function go(file, specifier) {
    const module = await goModule(path.dirname(path.join(root, file)));
    if (!module || (specifier !== module.name && !specifier.startsWith(module.name + "/"))) return EXTERNAL;
    const dir = path.join(module.dir, ...specifier.slice(module.name.length).split("/").filter(Boolean));
    return (await isDir(dir)) ? found(dir, "directory") : UNRESOLVED;
  }

  // Rust: `mod x;` is x.rs or x/mod.rs beside a mod.rs, lib.rs or main.rs, else in the folder named
  // after the declaring file. `use` paths walk the module tree; that is not built, so they stay unresolved.
  async function rust(file, specifier, form) {
    if (form !== "mod") return UNRESOLVED;
    const absolute = path.join(root, file);
    const name = path.basename(absolute, ".rs");
    const base = ["mod", "lib", "main"].includes(name) ? path.dirname(absolute) : path.join(path.dirname(absolute), name);
    for (const candidate of [path.join(base, specifier + ".rs"), path.join(base, specifier, "mod.rs")]) {
      if (await isFile(candidate)) return found(candidate);
    }
    return UNRESOLVED;
  }

  // Java: javac's source root is the file's folder less its package's folders; an import is a file (or,
  // with .*, a folder) under that root. A static import names a member, so its class is one name shorter.
  async function java(file, specifier, form, filePackage) {
    const dir = posix(path.posix.dirname(file));
    const packagePath = (filePackage ?? "").split(".").filter(Boolean).join("/");
    if (packagePath && !(dir === packagePath || dir.endsWith("/" + packagePath))) return UNRESOLVED;
    const sourceRoot = path.join(root, packagePath ? dir.slice(0, dir.length - packagePath.length) : dir);
    const parts = specifier.split(".");
    if (parts.at(-1) === "*") {
      const folder = path.join(sourceRoot, ...parts.slice(0, -1));
      return (await isDir(folder)) ? found(folder, "directory") : UNRESOLVED;
    }
    for (const length of form === "static" ? [parts.length - 1, parts.length] : [parts.length]) {
      const candidate = path.join(sourceRoot, ...parts.slice(0, length)) + ".java";
      if (await isFile(candidate)) return found(candidate);
    }
    // The JDK and other source roots are not read: not found here is not "outside".
    return UNRESOLVED;
  }

  // C++: a quoted include is first looked for beside the including file (GCC's search path, step one);
  // anything else needs the build's -I list. An angle include is a system header.
  async function cpp(file, specifier, form) {
    if (form === "system") return EXTERNAL;
    const candidate = path.join(path.dirname(path.join(root, file)), specifier);
    return (await isFile(candidate)) ? found(candidate) : UNRESOLVED;
  }

  return async function resolve(file, language, item, filePackage) {
    try {
      switch (language) {
        case "javascript": case "typescript": case "tsx": case "vue": return await javascript(file, item.specifier);
        case "python": return await python(file, item.specifier);
        case "go": return await go(file, item.specifier);
        case "rust": return await rust(file, item.specifier, item.form);
        case "java": return await java(file, item.specifier, item.form, filePackage);
        case "cpp": return await cpp(file, item.specifier, item.form);
        default: return UNRESOLVED;
      }
    } catch {
      return UNRESOLVED;
    }
  };
}
