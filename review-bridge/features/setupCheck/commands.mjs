// The resident page service from the command line: start it in the background, stop it, show it.
import path from "node:path";

import { serviceDown, serviceStatus, serviceUp } from "./pageService.mjs";

export async function upService({ paths, options }) {
  return (await serviceUp({
    paths,
    bootstrapPath: path.join(paths.bridgeRoot, "bootstrap.mjs"),
    watchArgs: options.fakeCli ? ["--fake-cli"] : [],
  })).exitCode;
}

export async function downService({ paths }) {
  return (await serviceDown({ paths })).exitCode;
}

export async function showService({ paths }) {
  return (await serviceStatus({ paths })).exitCode;
}
