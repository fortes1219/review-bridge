// The setup check's public entries: the page in the foreground, the resident service, and the
// running service's identity check that the start gate reads the reviewer proof through.
export * from "./commands.mjs";
export { checkService } from "./pageService.mjs";
export { startWatch } from "./startWatch.mjs";
