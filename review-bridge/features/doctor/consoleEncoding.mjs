// Windows PowerShell writes in the console's code page; Codex reads what it writes as UTF-8, so on
// a Windows set to Chinese (code page 950) its Chinese output arrives broken. doctor only says so
// and how to fix it; it never changes the person's profile.
import { spawnSync } from "node:child_process";
import path from "node:path";

const UTF8 = 65001;
export const PROFILE_LINE = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8";

// The code page PowerShell writes in, as Codex starts it (with the person's $PROFILE); null when
// PowerShell cannot be asked.
export function powershellCodePage() {
  const windowsPowerShell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const result = spawnSync(windowsPowerShell, ["-NoLogo", "-NonInteractive", "-Command", "[Console]::OutputEncoding.CodePage"], {
    encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
  const codePage = Number(String(result.stdout || "").trim());
  return result.status === 0 && Number.isInteger(codePage) ? codePage : null;
}

// One line when PowerShell does not write UTF-8 on Windows; null otherwise.
export function consoleEncodingHint({ platform = process.platform, codePage }) {
  if (platform !== "win32") return null;
  if (codePage === null || codePage === undefined) return "Could not ask PowerShell which code page it writes in. If Codex's Chinese output arrives broken, add this line to your PowerShell profile ($PROFILE): " + PROFILE_LINE;
  if (codePage === UTF8) return null;
  return "PowerShell writes in code page " + codePage + ", not UTF-8, so Codex's non-English output arrives broken. Add this line to your PowerShell profile ($PROFILE): " + PROFILE_LINE + " (or use PowerShell 7, pwsh)";
}
