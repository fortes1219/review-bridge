import path from "node:path";

export function inspectStateFilesystem(location, { platform = process.platform } = {}) {
  const resolved = platform === "win32" ? path.win32.resolve(location) : path.posix.resolve(location);
  const normalized = resolved.replaceAll("\\", "/");
  const reasons = [];
  if (/\/OneDrive(?:\/|$)/i.test(normalized)) reasons.push("OneDrive-synchronized path");
  if (/\/(?:Dropbox|Google Drive)(?:\/|$)/i.test(normalized)) reasons.push("synchronized storage path");
  if (/\/Library\/Mobile Documents(?:\/|$)/i.test(normalized)) reasons.push("iCloud-synchronized path");
  if (platform === "win32" && /^\/\//.test(normalized)) reasons.push("UNC/network path");
  if (platform !== "win32" && /^\/(?:net|nfs)(?:\/|$)/i.test(normalized)) reasons.push("network filesystem path");
  if (platform !== "win32" && /^\/mnt\/(?:nfs|cifs|smb)(?:\/|$)/i.test(normalized)) reasons.push("network filesystem mount");
  return {
    supported_for_concurrent_controller: reasons.length === 0,
    path: resolved,
    reasons,
  };
}

export function assertSupportedStateFilesystem(location, options) {
  const result = inspectStateFilesystem(location, options);
  if (!result.supported_for_concurrent_controller) {
    throw new Error("Unsupported controller state filesystem: " + result.reasons.join(", "));
  }
  return result;
}
