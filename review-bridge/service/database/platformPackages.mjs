// Which @embedded-postgres package carries the PostgreSQL binaries for a machine. Kept apart from
// the server module, which imports pg: the installer reads this before the dependencies exist.
const PLATFORM_PACKAGES = Object.freeze({
  "win32-x64": "windows-x64",
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
});

// The package name for this machine, or null when no binaries are packaged for it.
export function postgresPackageName({ platform = process.platform, arch = process.arch } = {}) {
  const name = PLATFORM_PACKAGES[platform + "-" + arch];
  return name ? "@embedded-postgres/" + name : null;
}
