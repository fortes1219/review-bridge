// The one way a feature calls a role's CLI: the provider's name picks the module, as Vitest's
// coverage `provider` picks v8 or istanbul, and every module answers in the same shape. Nothing
// outside the two modules knows a provider's flags or output.
import { callClaude } from "./claude.mjs";
import { callCodex } from "./codex.mjs";

const CALLS = Object.freeze({ claude: callClaude, codex: callCodex });

export async function callRole(provider, request) {
  const call = CALLS[provider];
  if (!call) throw new Error("No way to call " + provider + "; the provider is one of " + Object.keys(CALLS).join(", ") + ".");
  return await call(request);
}
