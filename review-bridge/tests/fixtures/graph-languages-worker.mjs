// Run by graph-languages.test.mjs in a process of its own. It reads { dataHome, samples } on stdin, installs
// and registers the grammars the samples name, reads each sample, prints one JSON line and then ends as
// Bridge's commands end, by itself: no process.exit, so the test can see whether a process that loaded
// the grammars still exits. Its own process also lets the test remove the folder afterwards, since Windows
// keeps a loaded grammar's file locked until the process that loaded it ends.
import * as napi from "@ast-grep/napi";

import { extractSource } from "../../service/graph/extract.mjs";
import { loadGrammars } from "../../service/graph/grammars.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { dataHome, samples } = JSON.parse(input);
const loaded = await loadGrammars(dataHome, new Set(Object.keys(samples)), { napi });
const results = {};
for (const [language, source] of Object.entries(samples)) {
  if (loaded.ready.has(language)) results[language] = await extractSource(napi, language, source);
}
process.stdout.write(JSON.stringify({ ready: [...loaded.ready], problems: loaded.problems, results }) + "\n");
