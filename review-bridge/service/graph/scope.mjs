// Which folders a project's graph covers (Owner 2026-11-08): the folder init ran in, and in a
// monorepo the package it is in plus every workspace package it depends on through `workspace:`. This
// follows voidzero-dev/vite-task's crates/vt_workspace, step by step:
//   find_workspace_root   walk up from the folder; pnpm-workspace.yaml, else a package.json with
//                         `workspaces`, counts only if its member globs include the nearest package
//   package_json_patterns npm map-workspaces' normalization: leading ! negates (odd count), ./ and /
//                         dropped, `/package.json` appended
//   get_package_json_paths the globs walked, never into node_modules
//   get_workspace_dependencies dependencies, devDependencies and peerDependencies whose version starts
//                         with `workspace:`; `workspace:name@range` names another package
//   build                 a dependency that names no workspace package is skipped; two packages with
//                         one name are an error; a package depending on itself adds nothing
// Paths are relative to the project folder with '/', and lead out of it with ../ for a package beside it.
import fsp from "node:fs/promises";
import path from "node:path";

const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
const posix = (file) => file.split(path.sep).join("/");

async function readIfExists(file) {
  try {
    return stripBom(await fsp.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readJson(file, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(file + " is not JSON (" + error.message + ").");
  }
}

async function pnpmGlobs(file, text) {
  const { parse } = await import("yaml");
  let value;
  try {
    value = parse(text);
  } catch (error) {
    throw new Error(file + " is not YAML (" + error.message + ").");
  }
  return Array.isArray(value?.packages) ? value.packages.map(String) : [];
}
const npmGlobs = (workspaces) => (Array.isArray(workspaces) ? workspaces : Array.isArray(workspaces?.packages) ? workspaces.packages : []).map(String);

function packageJsonPatterns(globs) {
  return globs.map((pattern) => {
    const exclusions = pattern.match(/^!*/)[0].length;
    let rest = pattern.slice(exclusions);
    const withoutDot = rest.startsWith(".") ? rest.slice(1) : rest;
    if (withoutDot.startsWith("/")) rest = withoutDot.replace(/^\/+/, "");
    const negated = exclusions % 2 === 1;
    return { glob: rest + (rest === "" || rest.endsWith("/") ? "package.json" : "/package.json"), negated };
  });
}

async function includes(globs, packagePath) {
  if (packagePath.split("/").includes("node_modules")) return false;
  const picomatch = (await import("picomatch")).default;
  const patterns = packageJsonPatterns(globs);
  const target = (packagePath ? packagePath + "/" : "") + "package.json";
  const positive = patterns.filter((item) => !item.negated).map((item) => item.glob);
  const negative = patterns.filter((item) => item.negated).map((item) => item.glob);
  return positive.length > 0 && picomatch(positive)(target) && !(negative.length && picomatch(negative)(target));
}

// The workspace the folder belongs to: { root, globs } or null when it belongs to none.
export async function findWorkspace(folder) {
  let nearest = null;
  for (let dir = path.resolve(folder); ; dir = path.dirname(dir)) {
    const relativeNearest = nearest === null ? null : posix(path.relative(dir, nearest));
    const pnpmFile = path.join(dir, "pnpm-workspace.yaml");
    const pnpm = await readIfExists(pnpmFile);
    if (pnpm !== null) {
      const globs = await pnpmGlobs(pnpmFile, pnpm);
      if (relativeNearest === null || await includes(globs, relativeNearest)) return { root: dir, globs };
    }
    const packageFile = path.join(dir, "package.json");
    const text = await readIfExists(packageFile);
    if (text !== null) {
      const manifest = await readJson(packageFile, text);
      // pnpm defines membership even when its globs leave this package out.
      if (pnpm === null && manifest.workspaces !== undefined) {
        const globs = npmGlobs(manifest.workspaces);
        if (relativeNearest === null || await includes(globs, relativeNearest)) return { root: dir, globs };
      }
      nearest ??= dir;
    }
    if (path.dirname(dir) === dir) return null;
  }
}

async function workspacePackages(workspace) {
  const { glob } = await import("tinyglobby");
  const patterns = packageJsonPatterns(workspace.globs);
  const found = await glob(patterns.filter((item) => !item.negated).map((item) => item.glob), {
    cwd: workspace.root, ignore: ["**/node_modules/**", ...patterns.filter((item) => item.negated).map((item) => item.glob)], onlyFiles: true,
  });
  const packages = [];
  let hasRoot = false;
  for (const file of found.sort()) {
    const dir = path.posix.dirname(file) === "." ? "" : path.posix.dirname(file);
    hasRoot ||= dir === "";
    const absolute = path.join(workspace.root, file);
    packages.push({ dir, manifest: await readJson(absolute, stripBom(await fsp.readFile(absolute, "utf8"))) });
  }
  // The root package is always part of the graph, even when the globs leave it out.
  if (!hasRoot) {
    const text = await readIfExists(path.join(workspace.root, "package.json"));
    packages.push({ dir: "", manifest: text === null ? {} : await readJson(path.join(workspace.root, "package.json"), text) });
  }
  return packages;
}

function workspaceDependencies(manifest) {
  const names = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [key, value] of Object.entries(manifest[field] ?? {})) {
      if (typeof value !== "string" || !value.startsWith("workspace:")) continue;
      const version = value.slice("workspace:".length);
      const at = version.lastIndexOf("@");
      names.push(at > 0 ? version.slice(0, at) : key);
    }
  }
  return names;
}

// The folders to graph, relative to `folder` ('' is the folder itself), and the workspace it was found in.
export async function graphScope(folder) {
  const project = path.resolve(folder);
  const workspace = await findWorkspace(project);
  if (!workspace) return { folders: [""], workspace: null };
  const packages = await workspacePackages(workspace);
  const byName = new Map();
  for (const item of packages) {
    const name = item.manifest.name;
    if (!name) continue;
    if (byName.has(name)) throw new Error("Two workspace packages are named " + name + ": " + (byName.get(name).dir || ".") + " and " + (item.dir || ".") + ".");
    byName.set(name, item);
  }
  // The package the folder is in: the deepest package folder that holds it.
  const inside = posix(path.relative(workspace.root, project));
  const own = packages
    .filter((item) => item.dir === "" || inside === item.dir || inside.startsWith(item.dir + "/"))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
  const seen = new Set([own.dir]);
  const queue = [own];
  while (queue.length) {
    const item = queue.shift();
    for (const name of workspaceDependencies(item.manifest)) {
      const dependency = byName.get(name);
      if (!dependency || seen.has(dependency.dir)) continue;
      seen.add(dependency.dir);
      queue.push(dependency);
    }
  }
  // The folder itself, then each dependency's folder as seen from it. The scope is init's folder (Owner
  // 2026-11-08), so a package that holds it (an ancestor, all `..`) adds nothing, and neither does a
  // folder inside another.
  const folders = [...seen].map((dir) => posix(path.relative(project, path.join(workspace.root, dir))))
    .filter((dir) => dir.startsWith("..") && !dir.split("/").every((part) => part === ".."));
  if (!folders.includes("")) folders.unshift("");
  const unique = [...new Set(folders)].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  return { folders: unique.filter((dir) => dir === "" || !unique.some((other) => other !== dir && other !== "" && dir.startsWith(other + "/"))), workspace: { root: workspace.root } };
}
