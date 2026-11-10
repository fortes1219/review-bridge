// A real terminal for the tests that need one (the Guide's questions, start's card), typed into the
// way a person types: Enter, y, n, Ctrl+C. @lydell/node-pty is node-pty with its binaries shipped
// per platform, so nothing is compiled when the tests are installed; where it does not load, the
// tests that need it are skipped and say why.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

let pty = null;
let unavailable = null;
try {
  pty = createRequire(import.meta.url)("@lydell/node-pty");
} catch (error) {
  unavailable = "no pseudo-terminal here (@lydell/node-pty did not load: " + String(error?.message || error).split("\n")[0] + ")";
}

// `skip` for node:test: false when a terminal is available, else the reason.
export const ptySkip = pty ? false : unavailable;
export const KEYS = Object.freeze({ enter: "\r", ctrlC: "\x03", down: "\x1b[B" });

// The screen's text without colours and cursor moves.
const plain = (raw) => raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g, "");

// Runs `node <args>` in a terminal. waitFor(pattern) waits for the screen to show it; press(keys)
// types; exited is the exit code; text() is everything shown so far.
export function terminal(args, { cwd, env, cols = 120, rows = 40, timeoutMs = 120_000 }) {
  const child = pty.spawn(process.execPath, args, { name: "xterm-256color", cols, rows, cwd, env });
  let raw = "";
  child.onData((data) => { raw += data; });
  const exited = new Promise((resolve) => child.onExit(({ exitCode }) => resolve(exitCode)));
  const text = () => plain(raw);
  return {
    text,
    raw: () => raw,
    exited,
    press: (keys) => child.write(keys),
    // Always called when a test ends, and waited for. On Windows node-pty's kill only schedules the work
    // and stops what its console list finds, five seconds later at worst (windowsPtyAgent.js), so a test
    // ended before its program did (2026-11-09: a `start` outlived its test by twenty minutes). As
    // Playwright stops a server it started (processLauncher.ts killProcessTree), the program's whole tree
    // goes first with taskkill /T /F; node-pty's kill then releases the pseudo-console, which only kill
    // does, even after the program ended ("AttachConsole failed" from its helper is harmless).
    kill: async () => {
      if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      try { child.kill(); } catch {}
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    },
    async waitFor(pattern) {
      for (const until = Date.now() + timeoutMs; !pattern.test(text());) {
        if (Date.now() > until) throw new Error("the terminal never showed " + pattern + "; it showed:\n" + text());
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // The prompt library draws the question, then starts reading keys.
      await new Promise((resolve) => setTimeout(resolve, 250));
    },
  };
}
