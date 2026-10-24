// The install Guide: one command after clone (`npm start`, which is `review-bridge init` without
// --target). It asks for the tools, shows what it will install, installs only after the person says
// yes, and ends with the next command, as create-vite does. It installs Bridge where it was cloned:
// no project is detected or set up here, no page service starts, and no copy of the runtime is made.
// Upgrading is the same command: the person gets the new version themselves (git pull or a new
// package) and runs npm start; the Guide sees the version changed and says so. Bridge runs no git.
// It runs before the dependencies exist, so it uses nothing but Node itself.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import readlinePromises from "node:readline/promises";

import { addToUserPath, commandLink, linkCommand, pathPlan } from "./command-link.mjs";
import { dependencyProblems, ensureDependencies, lockedDependencies } from "./dependencies.mjs";
import { installedVersion, readDefaultRoles, saveInstall, settingsFile } from "./personal-settings.mjs";
import { PROVIDERS, validateRoles } from "./role-readiness.mjs";
import { bridgeDataHome, databaseRoot } from "../review-bridge/service/database/dataHome.mjs";
import { postgresPackageName } from "../review-bridge/service/database/platformPackages.mjs";
import { bridgeUpgradeMarkerPath } from "../review-bridge/utils/paths.mjs";

const GUIDE_OPTIONS = new Set(["writer", "reviewer", "yes", "json"]);
export const ROOT_REFUSAL = "PostgreSQL 不能以 root 執行，請用一般使用者。";
export const NO_AUTOMATIC_ROLLBACK = "升級失敗不會自動退回：舊版由你自己取回，再還原升級前那份備份。";

function readinessText(check) {
  if (!check.cli_present) return "CLI 未安裝";
  if (check.authenticated === true) return "已登入";
  if (check.authenticated === false) return "需要登入";
  return "登入狀態不明";
}

// PostgreSQL's initdb refuses to run as root on macOS and Linux.
function runningAsRoot() {
  return process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0;
}

function databaseExists(dataHome) {
  return fs.existsSync(path.join(databaseRoot(dataHome), "data", "PG_VERSION"));
}

// Arrow-key menu and a y/N question at an interactive terminal.
export function terminalUi({ input = process.stdin, output = process.stdout } = {}) {
  return {
    async choose(title, choices, initialValue) {
      let index = Math.max(0, choices.findIndex((choice) => choice.value === initialValue));
      const render = (first) => {
        if (!first) {
          readline.moveCursor(output, 0, -choices.length);
          readline.clearScreenDown(output);
        }
        output.write(choices.map((choice, at) => (at === index ? "> " : "  ") + choice.label).join("\n") + "\n");
      };
      output.write(title + "（↑↓ 選擇，Enter 確定）\n");
      render(true);
      readline.emitKeypressEvents(input);
      const wasRaw = input.isRaw;
      input.setRawMode(true);
      input.resume();
      return await new Promise((resolve, reject) => {
        const finish = () => {
          input.off("keypress", onKey);
          input.setRawMode(wasRaw);
          input.pause();
        };
        const onKey = (text, key = {}) => {
          if (key.ctrl && key.name === "c") {
            finish();
            reject(new Error("Installation cancelled by user."));
          } else if (key.name === "up" || key.name === "down") {
            index = (index + (key.name === "up" ? choices.length - 1 : 1)) % choices.length;
            render(false);
          } else if (key.name === "return" || key.name === "enter") {
            finish();
            resolve(choices[index].value);
          }
        };
        input.on("keypress", onKey);
      });
    },
    async confirm(question) {
      const terminal = readlinePromises.createInterface({ input, output });
      try {
        return /^y(?:es)?$/i.test((await terminal.question(question)).trim());
      } finally {
        terminal.close();
      }
    },
  };
}

export function formatGuidePlan(plan) {
  const packages = plan.dependencies.packages.map((item) => "    " + item.name + " " + item.version
    + (item.name === plan.dependencies.postgres_package ? "（PostgreSQL 執行檔）" : ""));
  const command = plan.command.linked ? "review-bridge 已註冊"
    : plan.command.points_to ? "review-bridge 目前指向另一份 Bridge（" + plan.command.points_to + "），會改指向這份"
      : "註冊 review-bridge（npm 全域連結，寫進 " + plan.command.command_folder + "）";
  return [
    "",
    plan.upgrade ? "Review Bridge 會這樣升級：" : "Review Bridge 會這樣安裝：",
    ...(plan.upgrade ? ["  升級：從 " + plan.upgrade.from + " 升到 " + plan.upgrade.to + "：先備份資料庫、更新依賴",
      "  資料庫：" + (plan.upgrade.database_exists ? "已建立" : "還沒建立，不用備份")] : []),
    ...(plan.unfinished_upgrade ? ["  上一次升級沒有完成，這次重做"] : []),
    "  安裝位置：" + plan.install_location + "（就是這個資料夾，不另外複製）",
    "  writer：" + plan.roles.writer + "（" + plan.readiness.writer + "）",
    "  reviewer：" + plan.roles.reviewer + "（" + plan.readiness.reviewer + "）",
    ...(plan.dependencies.install
      ? ["  依賴：裝進 " + plan.dependencies.folder + "，需要網路或 npm 快取", ...packages]
      : ["  依賴：已安裝，不用下載"]),
    "  個人資料：" + plan.data_home + "（資料庫第一次用到時建立）",
    "  預設角色存在：" + plan.settings_file,
    "  指令：" + command,
    ...(plan.path.add_to_user_path ? ["  PATH：把 " + plan.path.folder + " 加進你的使用者 PATH（只在尾端追加一項）"] : []),
    ...(plan.path.shell_line ? ["  PATH：這個終端機找不到 " + plan.path.folder + "；請自己把這一行加進 shell 設定檔：", "    " + plan.path.shell_line] : []),
    ...(plan.upgrade ? ["  " + NO_AUTOMATIC_ROLLBACK] : []),
    "",
  ].join("\n") + "\n";
}

export function formatGuideResult(result) {
  const notReady = ["writer", "reviewer"].filter((role) => result.readiness[role] !== "已登入");
  return [
    "",
    (result.upgraded ? "Review Bridge 已升級到 " + result.version + "：" : "Review Bridge 已安裝在 ") + result.install_location,
    "預設角色：writer " + result.roles.writer + "、reviewer " + result.roles.reviewer + "（之後設定專案會沿用，也可以改）",
    ...notReady.map((role) => "  " + role + " " + result.roles[role] + "：" + result.readiness[role] + "，處理好之後才能真的開工"),
    ...(result.path.added_to_user_path ? ["已把 " + result.path.folder + " 加進你的使用者 PATH。"] : []),
    ...(result.path.shell_line ? ["review-bridge 指令在 " + result.path.folder + "；請把這一行加進 shell 設定檔，再開新的終端機：", "  " + result.path.shell_line] : []),
    ...(result.path.this_terminal ? [] : result.path.shell_line ? [] : ["請開新的終端機，再打下一步的指令。"]),
    "",
    "下一步，設定要工作的專案：",
    "  " + result.next_step,
    "",
  ].join("\n");
}

// Runs the Guide. `ui` is the interactive terminal, or null for a scripted install (then --yes and
// both roles, or saved defaults, are required). `inspectProvider` reports one provider's CLI and
// sign-in state without a model call.
export async function installGuide(packageRoot, options, {
  ui = null, write = () => {}, inspectProvider, dataHome = bridgeDataHome(),
  problemsOf = dependencyProblems, lockedOf = lockedDependencies, ensure = ensureDependencies,
  linkState = commandLink, link = linkCommand, pathOf = pathPlan, addPath = addToUserPath,
  asRoot = runningAsRoot, hasDatabase = databaseExists, markerPath = bridgeUpgradeMarkerPath(packageRoot),
} = {}) {
  for (const key of Object.keys(options)) {
    if (!GUIDE_OPTIONS.has(key)) throw new Error("--" + key + " belongs to setting up a project: review-bridge init --target <folder> --" + key + " ….");
  }
  const postgresPackage = postgresPackageName();
  if (!postgresPackage) throw new Error("No PostgreSQL binaries are packaged for " + process.platform + "-" + process.arch + ".");
  const interactive = ui !== null && !options.yes && !options.json;
  const readiness = {};
  for (const provider of PROVIDERS) readiness[provider] = readinessText(await inspectProvider(provider));
  const saved = await readDefaultRoles({ dataHome });
  const roles = {};
  for (const role of ["writer", "reviewer"]) {
    if (options[role]) roles[role] = options[role];
    else if (interactive) {
      roles[role] = await ui.choose("選擇 " + role, PROVIDERS.map((provider) => ({ value: provider, label: provider + " — " + readiness[provider] })), saved?.[role]);
    } else if (saved) roles[role] = saved[role];
    else throw new Error("Select both --writer and --reviewer explicitly.");
  }
  validateRoles(roles);

  const version = JSON.parse(await fsp.readFile(path.join(packageRoot, "package.json"), "utf8")).version;
  const previous = await installedVersion(packageRoot, { dataHome });
  const unfinished = fs.existsSync(markerPath);
  const problems = await problemsOf(packageRoot);
  const command = linkState(packageRoot);
  const plan = {
    install_location: packageRoot,
    roles,
    readiness: { writer: readiness[roles.writer], reviewer: readiness[roles.reviewer] },
    upgrade: previous !== null && previous !== version ? { from: previous, to: version, database_exists: hasDatabase(dataHome) } : null,
    unfinished_upgrade: unfinished,
    dependencies: {
      install: problems.length > 0,
      folder: path.join(packageRoot, "node_modules"),
      packages: await lockedOf(packageRoot),
      postgres_package: postgresPackage,
    },
    data_home: dataHome,
    settings_file: settingsFile(dataHome),
    command,
    path: pathOf(command.command_folder),
  };
  write(formatGuidePlan(plan));
  if (asRoot()) throw new Error(ROOT_REFUSAL);
  // The backup before an upgrade is not built yet; an existing database is not upgraded without one.
  if (plan.upgrade?.database_exists) throw new Error("這台機器已經有 Bridge 的資料庫，但這一版還不能在升級前備份它，所以這次不升級。");
  if (interactive) {
    if (!(await ui.confirm((plan.upgrade ? "開始升級？" : "開始安裝？") + "[y/N] "))) throw new Error("Installation cancelled by user.");
  } else if (!options.yes) {
    throw new Error("No terminal to confirm at. Add --yes to install as shown.");
  }

  // Upgrading Bridge: every command refuses to start until this run finishes. A failed upgrade
  // leaves the marker; running npm start again is how it is finished.
  if (plan.upgrade || unfinished) {
    await fsp.writeFile(markerPath, JSON.stringify({ operation: "upgrade", from: previous, to: version, started_at: new Date().toISOString() }, null, 2) + "\n", "utf8");
  }
  const installed = await ensure(packageRoot, { notify: (line) => write(line + "\n") });
  if (!command.linked) link(packageRoot);
  const linked = linkState(packageRoot);
  if (!linked.linked) throw new Error("npm link finished, but review-bridge does not point at " + packageRoot + ".");
  if (plan.path.add_to_user_path) addPath(plan.path.folder);
  await saveInstall({ roles, location: packageRoot, version }, { dataHome });
  await fsp.rm(markerPath, { force: true });
  return {
    ok: true,
    operation: "install_bridge",
    install_location: packageRoot,
    version,
    upgraded: plan.upgrade !== null,
    roles,
    readiness: plan.readiness,
    dependencies_installed: installed.installed,
    command: { registered: true, command_folder: linked.command_folder },
    path: { ...plan.path, added_to_user_path: plan.path.add_to_user_path },
    data_home: dataHome,
    settings_file: plan.settings_file,
    next_step: "review-bridge init --target <專案資料夾>",
  };
}
