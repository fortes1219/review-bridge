// A stand-in for `codex app-server`: answers initialize, thread/start and turn/start, then replays
// a recorded session's notifications. Usage: node fake-codex-app-server.mjs <fixture> <mode> <record>
// <mode> is one base mode plus optional "+"-joined variations:
//   replay      send everything
//   hang        stop before the root turn ends; record every turn/interrupt into <record>
//   deaf        like hang, but never answer an interrupt
//   stall-init  never answer initialize
//   +root=<status>   end the root turn with this status instead of the recorded one
//   +no-child-turn   announce sub-agents but never start their turns
import fs from "node:fs";
import readline from "node:readline";

const [fixture, modeArg, record] = process.argv.slice(2);
const [mode, ...variations] = modeArg.split("+");
const rootStatus = variations.find((value) => value.startsWith("root="))?.slice(5) || null;
const noChildTurn = variations.includes("no-child-turn");
const [header, ...events] = fs.readFileSync(fixture, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const root = header.root_thread_id;
const rootTurn = events.find((event) => event.method === "turn/started" && event.params.threadId === root)?.params.turn.id;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const hangs = mode === "hang" || mode === "deaf";

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return mode === "stall-init" ? undefined : send({ id: message.id, result: {} });
  if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: root } } });
  if (message.method === "turn/interrupt") {
    if (record) fs.appendFileSync(record, JSON.stringify(message.params) + "\n");
    return mode === "deaf" ? undefined : send({ id: message.id, result: {} });
  }
  if (message.method !== "turn/start") return undefined;
  send({ id: message.id, result: { turn: { id: rootTurn } } });
  for (const event of events) {
    const endsRoot = event.method === "turn/completed" && event.params.threadId === root;
    if (hangs && endsRoot) break;
    if (noChildTurn && event.method === "turn/started" && event.params.threadId !== root) continue;
    send(endsRoot && rootStatus ? { ...event, params: { ...event.params, turn: { ...event.params.turn, status: rootStatus } } } : event);
  }
  return undefined;
});
// Stay alive like the real server until the client ends it.
setInterval(() => {}, 1_000);
