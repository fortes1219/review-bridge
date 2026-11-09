// How a person runs Bridge again from where they are: their package manager's one-off form, without a
// version, so it is the latest. As create-vite reads it (src/index.ts pkgFromUserAgent and the one-off
// forms it prints): the first word of npm_config_user_agent names the package manager, npm when there
// is none; pnpm dlx, yarn dlx (not Yarn 1), bun x, deno run -A npm:. npm's form is npx, not npm exec:
// npx hands every flag after the package name to Bridge (npm-exec.md, "npx vs npm exec"), so a
// `start <file> --yes` keeps its --yes. Run from a global install, npx runs that install (libnpmexec).
export function bridgeRunner(env = process.env) {
  const [name, version = ""] = String(env.npm_config_user_agent || "").split(" ")[0].split("/");
  if (name === "pnpm") return "pnpm dlx review-bridge";
  if (name === "yarn" && !version.startsWith("1.")) return "yarn dlx review-bridge";
  if (name === "bun") return "bun x review-bridge";
  if (name === "deno") return "deno run -A npm:review-bridge";
  return "npx review-bridge";
}

// One command line to print: `bridgeCommand("start <file>")` is "npx review-bridge start <file>".
export function bridgeCommand(rest = "", env = process.env) {
  return bridgeRunner(env) + (rest ? " " + rest : "");
}
