// What the person reads when a work order lacks what it must say (Owner 2026-11-08: the work order is a
// form, and a form without its required fields is not sent). The refusal names each block and line in the
// project's language, and a required block whose marker the person deleted is written back at the end of
// the file, marker and heading only, so they see where to write: Bridge only adds what is missing and never
// changes a line they wrote. The file it adds to is a new version, read again on the next start.
import fsp from "node:fs/promises";
import path from "node:path";

import { digest } from "../../utils/digest.mjs";
import { sealedText, withWorkOrderId, workOrderIdOf } from "./workOrderFormat.mjs";

// The lines the refusal prints, in order: what is missing, each loose acceptance line, each open question.
export function formLines(t, form, { file, again, writtenBack = [] }) {
  return [
    t("form.refused", { file }),
    ...form.missing.map((key) => "- " + t("form.missing." + key)),
    ...form.loose.map((line) => "- " + t("form.loose", { line })),
    ...form.questions.map((entry) => "- " + t("form.question", { line: entry.line, question: entry.question })),
    ...(writtenBack.length ? [t("form.written_back", { blocks: writtenBack.map((key) => t("form.heading." + key)).join(t("form.separator")) })] : []),
    t("form.again", { command: again }),
  ];
}

// The refusal for one work-order file: its missing markers written back, then the lines printed.
export async function refuseForm(t, error, { absolute, file, again, write }) {
  const writtenBack = await writeBackBlocks(t, absolute, error.form.unmarked);
  for (const line of formLines(t, error.form, { file, again, writtenBack })) write(line);
}

// Appends the marker and heading of each required block the work order no longer has. Returns the keys
// it wrote back. The text before them stays byte for byte.
export async function writeBackBlocks(t, file, keys) {
  if (!keys.length) return [];
  const text = await fsp.readFile(file, "utf8");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  // A blank line before each block, as the template has; the last line of the file is ended first.
  const ending = text.length && !text.endsWith("\n") ? newline : "";
  const blocks = keys.flatMap((key) => ["", "<!-- bridge:" + key + " -->", "## " + t("form.heading." + key)]);
  await fsp.appendFile(file, ending + blocks.join(newline) + newline, "utf8");
  return keys;
}

// Once a start has recorded the work order and its authorization (Owner 2026-11-08: the records first, then
// the file, as Jira gives an issue its key before it is printed on it): each plan's work order id goes into
// its file's front matter, as Docusaurus reads a document's id there, so the file is that work order
// wherever it goes. A file that already holds it is left as it is; one that changed since the card is not
// touched (its start is refused for that). Only the id line is written: the sealed text, and so the
// contract's hash, stay.
export async function writeWorkOrderIds(paths, plans) {
  for (const plan of plans) {
    const id = plan.work_order?.work_order_id;
    if (!plan.task_file || !id) continue;
    const file = path.join(paths.repoRoot, ...plan.task_file.split("/"));
    const raw = await fsp.readFile(file, "utf8").catch(() => null);
    if (raw === null || workOrderIdOf(raw) === id || digest(sealedText(raw).trim()) !== plan.task_sha256) continue;
    await fsp.writeFile(file, withWorkOrderId(raw, id), "utf8");
  }
}
