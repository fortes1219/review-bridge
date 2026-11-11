// The resident page service and the person's database from the command line, the way docker compose
// treats what `up` starts (RC3-DOWN-01): `up` starts the database and then the page in the background,
// `down` stops the page and then the database and refuses while a run is running, `ps` shows the page.
// What these say about the database is in the project's language.
import { createTranslator, resolveLocale } from "../workOrder/i18n.mjs";
import { serviceDown, serviceStatus, serviceUp } from "./pageService.mjs";

// The database module loads pg and the server binaries, so it is loaded only by the commands that use it.
const databaseModule = () => import("../../service/database/index.mjs");
const silent = { write() {} };

export async function upService({ paths, options, out = process.stdout, database = null }) {
  const t = await createTranslator(await resolveLocale(paths));
  const records = await (database ?? databaseModule());
  const opened = await records.openDatabase();
  out.write(t("up.database", { port: opened.connection.port }) + "\n");
  return (await serviceUp({
    paths,
    ownerArgs: options.fakeCli ? ["--fake-cli"] : [],
    out,
  })).exitCode;
}

// Everything `up` started is stopped, as docker compose down removes what up created, and a database
// that is already down still has what a dead server left cleared. One person's database serves every
// project, so a run running in any of them refuses it, and nothing is stopped (backup's rule).
export async function downService({ paths, out = process.stdout, database = null, page = serviceDown }) {
  const t = await createTranslator(await resolveLocale(paths));
  const records = await (database ?? databaseModule());
  const running = await records.runsRunning();
  if (running.length) {
    out.write(t("down.refused") + "\n" + records.runLines(running) + "\n");
    return 2;
  }
  const pageDown = await page({ paths, out: silent });
  const pageFailed = pageDown.exitCode === 2;
  out.write(t(pageFailed ? "down.page.failed" : pageDown.reason === "stopped" ? "down.page.stopped" : "down.page.not_running") + "\n");
  const databaseDown = await records.stopDatabase();
  out.write(t("down.database." + databaseDown.database, { pid: databaseDown.pid }) + "\n");
  return pageFailed ? 2 : 0;
}

export async function showService({ paths }) {
  return (await serviceStatus({ paths })).exitCode;
}
