// The setup check's public entries: the page in the foreground, the resident service, and how a command
// finds it: without waiting for what only looks (status), waiting for what uses it (the start gate).
export * from "./commands.mjs";
export { checkPageStatus, observePage } from "./pageService.mjs";
export { runPageService } from "./pageOwner.mjs";
export { ensureReviewerChecked } from "./reviewerCheck.mjs";
export { startWatch } from "./startWatch.mjs";
