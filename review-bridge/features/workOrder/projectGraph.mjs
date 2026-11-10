// The project's graph as the writer's and the reviewer's prompts carry it: Bridge reads it itself (the
// service's graphContext), the model is not asked whether to look. Shared by the writer loop and the review.
import { recordsDatabase } from "../../service/index.mjs";

// The words of the work order the graph is asked about: its title, what to do, and its conditions.
export function workOrderTexts(contract, workPackage) {
  if (!contract) return [workPackage?.task];
  return [contract.ticket?.title, contract.requested_work?.text, ...(contract.acceptance || []).map((item) => item.statement)];
}

// `read(db, projectId)` against the project's records: null without records or without a graph; a read that
// fails is kept as its reason with nothing put into the prompt, never as "no graph".
export async function readProjectGraph(paths, read, { database = recordsDatabase() } = {}) {
  if (!database) return null;
  try {
    return await read(await database(), paths.projectId);
  } catch (error) {
    return { text: null, queries: 0, tokens: 0, error: String(error?.message || error) };
  }
}

// What a prompt's event records of it: the statements read (only where they were read) and the tokens put in.
export const graphStats = (graph, read = true) => ({ queries: read ? graph.queries : 0, tokens: graph.text ? graph.tokens : 0, ...(graph.error ? { error: graph.error } : {}) });
