import path from "node:path";

import { closeLifeline, launchPage } from "./pageService.mjs";

// The setup page in this terminal until Ctrl+C. The page service is started the one way `up` starts it,
// with its stdin held by this process: Ctrl+C, or this terminal closing or dying, ends that stdin and the
// page service shuts itself down (supabase/cli c75aea2 ARCHITECTURE.md:491, a session stack's lifeline;
// HostProcess.ts:439-447,594-604). A page service already running is attached to and left running.
export async function startWatch({ paths, port, options = {} }) {
  const ownerArgs = [...(port === undefined ? [] : ["--port", String(port)]), ...(options.fakeCli ? ["--fake-cli"] : [])];
  const launched = await launchPage(paths, { bootstrapPath: path.join(paths.bridgeRoot, "bootstrap.mjs"), ownerArgs, lifetime: "session" });
  if (launched.notice) process.stdout.write(launched.notice + "\n");
  process.stdout.write("Review Bridge setup page: " + launched.url + "\n"
    + "Opening or refreshing the page uses no model. Press Ctrl+C to stop.\n");
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  if (!launched.attached) await closeLifeline(launched.child);
  return 0;
}
