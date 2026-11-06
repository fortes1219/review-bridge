// When a work order stops to ask the person (RC3-ASK-01). The run has already closed; what happens
// here is outside any run. The person answers at the terminal, or through an agent with --answer, and
// the answer is written back into the work order, so the document stays whole, as spec-kit's
// /speckit.clarify keeps its ## Clarifications. Bridge only adds to the blocks a work order lacks
// (clarifications, acceptance); it never changes a line the person wrote. A changed file is a new version
// and takes a new yes, on the way every edited work order goes.
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import { styleText } from "node:util";

import { localTimestamp } from "../../utils/dates.mjs";
import { digest } from "../../utils/digest.mjs";
import { inEveryLocale } from "./i18n.mjs";
import { parseWorkOrder, workOrderLines } from "./workOrderFormat.mjs";

// Colour only where the output is a terminal that takes it: styleText looks at the stream, NO_COLOR,
// NODE_DISABLE_COLORS and FORCE_COLOR itself.
export const yellow = (text) => styleText("yellow", text);

const flat = (text) => String(text).replace(/\s+/g, " ").trim();

// The questions a closed run left for the person, or null.
export function pendingQuestions(run) {
  const questions = run?.last_state?.clarify_questions;
  return questions?.length ? questions : null;
}

function readingLabel(t, reading) {
  const why = [
    ...(reading.precedent ? [t("clarify.precedent." + reading.precedent.source, { note: reading.precedent.note })] : []),
    ...(reading.recommended ? [t("clarify.recommended")] : []),
  ].join(t("clarify.reading.separator"));
  // A proposal of acceptance is one condition per line; on one line here they stay apart.
  const text = String(reading.text).split(/\r?\n/).map(flat).filter(Boolean).join(" / ");
  return why ? t("clarify.reading", { text, why }) : text;
}

// The questions as text: printed for an agent to relay, and in the result's Why.
export function questionLines(t, questions) {
  return questions.flatMap((question, index) => [
    (index + 1) + ". " + flat(question.question),
    ...(question.no_precedent ? ["   " + t("clarify.no_precedent")] : []),
    ...question.readings.map((reading, at) => "   " + (at + 1) + ") " + readingLabel(t, reading)),
    "   ai) " + t("clarify.exit.ai"),
    "   " + t("clarify.exit.say"),
  ]);
}

// One select per question, then a line of text for "say it yourself": the prompt library's select has no
// "other". The file is written only after every question is answered, so stopping here leaves nothing.
// Null when the person cancels (Ctrl+C or Esc). Handing a question to the AI hands over the rest.
export async function askAnswers(t, questions) {
  const clack = await import("@clack/prompts");
  const answers = [];
  for (const question of questions) {
    const pick = await clack.select({
      message: flat(question.question) + (question.no_precedent ? " " + t("clarify.no_precedent") : ""),
      showInstructions: false,
      options: [
        ...question.readings.map((reading, at) => ({ value: at, label: (at + 1) + ". " + readingLabel(t, reading) })),
        { value: "ai", label: t("clarify.exit.ai") },
        { value: "say", label: t("clarify.exit.say") },
      ],
    });
    if (clack.isCancel(pick)) return null;
    if (pick === "ai") {
      for (const rest of questions.slice(answers.length)) answers.push({ kind: "ai", text: rest.recommended.text });
      return answers;
    }
    if (pick !== "say") { answers.push({ kind: "reading", text: question.readings[pick].text }); continue; }
    const said = await clack.text({ message: t("clarify.say.prompt"), validate: (value) => (flat(value ?? "") ? undefined : t("clarify.say.empty")) });
    if (clack.isCancel(said)) return null;
    answers.push({ kind: "person", text: flat(said) });
  }
  return answers;
}

// --answer, repeated, one per question in order: a number in range is a reading, `ai` hands this one and
// the rest over, anything else is the person's own sentence. A number out of range is a mistake, not a
// sentence.
export function answersFromOption(values, questions) {
  const answers = [];
  for (const value of values) {
    const question = questions[answers.length];
    if (!question) throw new Error("There are " + questions.length + " question(s) and more --answer than that. Give one --answer per question, in order.");
    const text = flat(value).normalize("NFKC");
    if (!text) throw new Error("--answer " + (answers.length + 1) + " is empty. Give a number, ai, or what the person said.");
    if (/^ai$/i.test(text)) {
      for (const rest of questions.slice(answers.length)) answers.push({ kind: "ai", text: rest.recommended.text });
      return answers;
    }
    if (/^\d+$/.test(text)) {
      const reading = question.readings[Number(text) - 1];
      if (!reading) throw new Error("--answer " + text + " is not one of question " + (answers.length + 1) + "'s " + question.readings.length + " reading(s). Give a number in range, ai, or what the person said.");
      answers.push({ kind: "reading", text: reading.text });
      continue;
    }
    answers.push({ kind: "person", text: flat(value) });
  }
  if (answers.length !== questions.length) throw new Error("There are " + questions.length + " question(s) and " + answers.length + " --answer. Give one --answer per question, in order, or --answer ai.");
  return answers;
}

// The text with `added` after line `number`, every other byte as it was.
function insertAfterLine(body, number, added, eol) {
  const breaks = [...body.matchAll(/\r?\n/g)];
  const at = breaks[number - 1];
  if (!at) return body + eol + added.join(eol) + eol;
  const offset = at.index + at[0].length;
  return body.slice(0, offset) + added.join(eol) + eol + body.slice(offset);
}

// Adds lines to a block: at the end of what it holds if it is there (a template's empty block too), else
// as a new block at the end of the file.
function addToBlock(body, key, heading, added) {
  const eol = /\r\n/.test(body) ? "\r\n" : "\n";
  const lines = workOrderLines(body);
  const block = parseWorkOrder(body).blocks.get(key);
  if (block) {
    const last = Math.max(block.marker, ...block.all.filter((number) => lines[number - 1].trim()));
    const headed = block.all.some((number) => /^#{2,3}\s/.test(lines[number - 1]));
    return insertAfterLine(body, last, [...(headed ? [] : [heading]), ...added], eol);
  }
  const ended = /\n$/.test(body) ? body : body + eol;
  return ended + (/\n\s*\n$/.test(ended) ? "" : eol) + ["<!-- bridge:" + key + " -->", heading, ...added].join(eol) + eol;
}

// Writes the answers into the work order, as long as it is still the text the questions were about.
// Returns the line each clarification landed on, by answer, for the next round to recognise.
export async function writeAnswers({ t, file, sealedSha256, questions, answers, now = new Date() }) {
  const raw = await fsp.readFile(file, "utf8");
  if (digest(raw.trim()) !== sealedSha256) throw new Error("The work order changed after these questions were asked, so the answers were not written. Run: review-bridge start again and answer on the new card.");
  const bom = raw.startsWith("﻿") ? "﻿" : "";
  let body = raw.slice(bom.length);
  const at = localTimestamp(now).slice(0, 16);
  const conditions = [];
  const clarifications = answers.map((answer, index) => {
    const question = questions[index];
    if (question.acceptance_proposal && answer.kind !== "person") conditions.push(...String(answer.text).split(/\r?\n/).map(flat).filter(Boolean));
    // A chosen set of conditions says everything in the acceptance block.
    if (question.acceptance_proposal && answer.kind === "reading") return null;
    return "- " + at + " " + t("clarify.line", { question: flat(question.question), answer: flat(answer.text) }) + (answer.kind === "ai" ? t("clarify.line.ai") : "");
  });
  if (conditions.length) body = addToBlock(body, "acceptance", t("clarify.heading.acceptance"), conditions.map((text, index) => (index + 1) + ". " + text));
  const written = clarifications.filter(Boolean);
  if (written.length) body = addToBlock(body, "clarifications", t("clarify.heading"), written);
  // Nothing goes to disk that Bridge could not read back.
  parseWorkOrder(body);
  const temporary = file + "." + randomUUID().slice(0, 8) + ".tmp";
  await fsp.writeFile(temporary, bom + body, "utf8");
  await fsp.rename(temporary, file);
  const final = workOrderLines(body.trim());
  return clarifications.map((line) => (line ? final.lastIndexOf(line) + 1 : null));
}

// What the next plan carries (sealed with it, so the agent's later processes have it too). A fresh start
// carries nothing: it is a new start, whatever was asked before. Only what the person said in their own
// words stays open, by the lines the question was about and the line their words landed on.
export function nextClarify(previous, { questions, answers, lines }) {
  const round = previous?.round ?? 1;
  return {
    round: round + 1,
    ai_decides: Boolean(previous?.ai_decides) || answers.some((answer) => answer.kind === "ai"),
    open_refs: answers.flatMap((answer, index) => (answer.kind === "person"
      ? [...questions[index].source_refs, ...(lines[index] ? [{ start: lines[index], end: lines[index] }] : [])]
      : [])),
    history: [...(previous?.history || []), {
      round,
      items: answers.map((answer, index) => ({ question: flat(questions[index].question), answer: flat(answer.text), kind: answer.kind })),
    }],
  };
}

// The record a plan starts from. A new start does not take up questions left half answered, but what the
// work order itself says counts (hard condition 1, Owner 2026-11-06): a line in its clarifications handing
// the later details to the AI holds until the person takes it out of the file.
export async function clarifyForPlan(carried, format) {
  if (carried?.ai_decides) return carried;
  const written = (format.blocks.get("clarifications")?.content || []).map((number) => format.lines[number - 1]);
  if (!written.length) return carried ?? null;
  const marks = await inEveryLocale("clarify.mark.ai");
  if (!written.some((line) => marks.some((mark) => line.includes(mark)))) return carried ?? null;
  return { ...(carried ?? { round: 1, open_refs: [], history: [] }), ai_decides: true };
}

// When every round was asked and it still cannot be settled: what was asked and answered, for the
// terminal and the result alike.
export function exhaustedLines(t, history) {
  return [
    t("result.why.clarify.exhausted", { rounds: history?.length ?? 0 }),
    ...(history || []).flatMap(({ round, items }) => [
      t("clarify.history.round", { round }),
      ...items.map((item) => "- " + t("clarify.line", { question: item.question, answer: item.answer }) + (item.kind === "ai" ? t("clarify.line.ai") : "")),
    ]),
  ];
}

// What the sealed contract took without asking: "採用的讀法" in the result.
export function assumptionLines(t, assumptions) {
  return (assumptions || []).map((item) => "- " + t("clarify.line", { question: flat(item.question), answer: flat(item.adopted) })
    + (item.decided_by === "ai" ? t("clarify.line.ai") : item.decided_by === "convention" ? t("clarify.line.convention") : ""));
}
