# When Bridge needs your input

You shouldn't have to write a full spec to get started. Bridge should handle details that follow your project's conventions and ask you only about choices that meaningfully affect the result or how it's verified. When it does ask, it should explain the tradeoffs, recommend an option, and let you answer right where you're working.

> **Implementation status (November 6, 2026):** This page describes an agreed design that's still being implemented. It first covers questions that come up when turning a work order into a contract. Questions from the writer during implementation will use the same flow in a later update. The examples below distinguish actual test findings from mockups of the new flow.

## The problem: endless questions before any code gets written

In one hands-on test, we ran a folder containing three simple work orders. One just asked for startup instructions in the README:

```markdown
# Add startup instructions to the README

<!-- bridge:requested_work -->
## What to do
Add a "Getting started" section to README.md with commands to install dependencies and start the project.

<!-- bridge:acceptance -->
## Acceptance criteria
1. README.md has a "Getting started" section.
2. That section includes at least one command in a code block that users can copy and run.
```

All three work orders stopped during contract preparation, before implementation began. The terminal said a human decision was needed and showed a path to the result file. Only after opening that file did we see the question: Did "copy and run" mean the command had to be complete, or that it actually had to run successfully in this project?

We made the requirement more explicit: use commands that actually exist in `package.json`. On the second attempt, all three stopped again. This time, the questions included:

- `npm install` isn't in `scripts`. Does the install command have to be listed there too?
- Does "three sections" mean exactly three, or at least three? Can there also be an introduction?
- Does "at the top" mean the very first line, or can a `# Changelog` heading come first?

You can find a reason to ask each question. But handled this way, a work order is never specific enough. Each round requires another contract draft and review, spending more tokens while implementation hasn't even started.

The original design handled "stop when something is ambiguous" without handling what comes next: which questions are worth asking, how to ask them, where answers belong, and how to continue. Passing tests with fake CLIs and tightly specified work orders didn't show that a person could actually get through the process.

## What Bridge should ask you

The reviewer identifies possible interpretations and their impact. Bridge then applies the rules for each category. A model saying "I'm not sure" doesn't automatically mean work stops.

| Category | What it means | What happens |
|---|---|---|
| Affects verification (`verification`) | Different interpretations of the same requirement would change whether it passes | Ask you to decide |
| Affects the result (`implementation`) | Different approaches would noticeably change the feature or user experience | Ask you to decide |
| Minor detail (`preference`) | The choice wouldn't materially change the result or verification | Use the recommendation and record it in the contract and result file without asking |

**Follow established project or ecosystem conventions first.** For example, `npm install` doesn't need an entry in `scripts`. You shouldn't have to decide that. Bridge still records the interpretation it uses.

The model still decides how to classify a question. Code can control how that classification is handled, how many questions get asked, and when follow-ups are allowed. Those limits don't prove the model always picks the right category, but they keep it from sending an unlimited stream of questions back to you.

The first round has at most **3 questions**, each with at most **3 interpretations or approaches**. The reviewer ranks them by impact and uncertainty; Bridge takes the top three and records the recommended answers for the rest. Reports missing a required category or recommendation are treated as malformed output, rather than shown to you as questions.

## Pick a recommendation or answer in your own words

Questions appear directly in the terminal, so you don't need to open a result file. If you're working through Claude Code or Codex, the agent presents them in its question interface.

This is a **mockup of the new flow**. The options and source labels illustrate the format; they aren't findings from a real project:

```text
What kind of effect do you mean by "a button with a moving glow"?
  › 1. Continuously shifting background colors (recommended; uses the project's existing gradient animation)
    2. A band of light sweeping across the button (model knowledge, unverified)

    Let AI decide → Use the recommendation and let AI handle remaining details for this work order
    Describe what you want → Answer in your own words
```

Each option must say what it's based on: something already used in the project, a lookup result, or the model's existing knowledge. Model knowledge is labeled "unverified." Options without a stated basis are removed. If no options remain, the interface explains that and still offers "Let AI decide" and "Describe what you want."

The initial design uses readable project content and model knowledge. Until read-only lookup tools are connected, external information that a model claims to have looked up must also be labeled "unverified." Actual npm and GitHub lookup results can become sources once that integration is available; model memory doesn't count as a lookup.

You don't need to know CSS, animation functions, or package names. "Rounder and slower" is a valid answer; the model turns that into requirements it can act on. Even if your whole work order is "I want a button with a moving glow," with no acceptance criteria, the model proposes a way to verify it too. You can choose an approach or let AI decide.

## Once you've answered, no more variations on the same question

Bridge enforces these limits in code:

- **Ask the questions together in the first round.** Don't ask one at a time and add new questions in later rounds.
- **Don't revisit a selected option.** From the second round on, follow-ups can only clarify something you wrote in your own words. Other questions use the recommendation and are recorded.
- **"Let AI decide" applies to the whole work order.** Later ambiguities use the recommendation, marked as an AI decision, without asking you again.
- **Stop after 3 rounds.** The model isn't told the round limit. If the questions still can't be resolved, the process ends with `action_required` and displays and records the exchange.

Choosing an option closes that question. Only a free-text answer that still needs clarification can lead to another round. "Let AI decide" delegates the remaining details; you still need to approve a new authorization card after the work order changes.

These questions come after a candidate contract is drafted and before it's sealed. Once the contract is sealed, this flow doesn't keep reopening questions. Questions that come up during the writer's implementation will be connected separately.

## Save the answers in the work order, then approve the new version

Your answers stay in the work order. You don't have to recover them from a conversation or result file and write them up again. Bridge appends the selected answers to its own clarification block at the end of the file, leaving your original wording intact:

```markdown
<!-- bridge:clarifications -->
## Clarifications
- 2026-11-06 11:52 — For "a button with a moving glow," use the project's existing gradient animation. (AI decision; let AI decide remaining details too.)
```

If the work order had no acceptance criteria, the agreed criteria are also appended in a `<!-- bridge:acceptance -->` block.

The full flow is: **answer the questions → Bridge saves the answers in the work order → see a new authorization card → approve it → regenerate, check, and seal the contract → begin implementation.** These steps continue within the same `start` command. You don't need to edit the Markdown yourself and run the command again.

You're asked to approve again because your answers changed the work order. That updated version needs your authorization. Recommendations for minor details are recorded only in the contract and result file; they don't change the work order or trigger another approval.

Before asking questions, the original run ends with `action_required`. After the answers are saved, a new run is created from the updated work order. For a batch of work orders, Bridge finishes the batch and shows a summary first, then collects answers for the ones that need them. Work orders already delivered are skipped when you start again.

Press **Ctrl+C or Esc** to leave the question flow. Bridge waits until you've answered the whole batch before writing anything, so leaving halfway through doesn't save partial answers to the work order. The next `start` begins fresh from the file on disk; it doesn't resume the previous exchange.

## Design references and what's specific to Bridge

This flow draws on how existing tools ask questions. Bridge also needs to preserve an approval step: **when answers change the work order, you must approve the updated version.**

| Existing approach | Source | How Bridge uses it |
|---|---|---|
| Ask only about choices that materially affect implementation or verification, rank by impact and uncertainty, and limit the number of questions | [GitHub spec-kit's clarify command](https://github.com/github/spec-kit/blob/main/templates/commands/clarify.md) | Enforce a maximum of 3 questions in the first round |
| Offer a few options with the recommendation first, and allow free-text answers | [Codex's question tool definition](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input_spec.rs) | Offer at most 3 interpretations or approaches, plus "Let AI decide" and "Describe what you want" |
| Write answers back to the spec so decisions are preserved | [spec-kit's Clarifications flow](https://github.com/github/spec-kit/blob/main/templates/commands/clarify.md) | Append to the work order's own clarification block without rewriting the original text |
| Control who can ask questions and whether execution waits for an answer | [Codex's question tool handler](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input.rs) | Let Bridge control when to ask, then present questions in the terminal or agent interface |

spec-kit usually asks one question at a time. Bridge's questions come from an independent, read-only reviewer. Each answer requires the writer to regenerate the contract and the reviewer to check it, adding model calls. That's why Bridge groups questions in the first round and limits follow-ups.

The following are Bridge-specific rules. The tools above don't provide these same mechanisms:

- "Let AI decide" applies the recommendation to remaining details across the whole work order.
- From the second round on, follow-ups can only clarify the user's free-text answers.
- The reviewer labels each question's impact; code decides how to handle it.
- Each round uses a fresh session. References to locations in the work order identify whether a question concerns the same issue.

## Conclusion

Questions should help you make choices that affect the result, then let you get back to work. Bridge limits the number of questions and follow-ups, saves your answers in the work order, and lets you describe what you want in your own words while checking exactly what you're approving.

If your team keeps getting the same questions, put together a knowledge base the agent can consult before asking. Start with:

- **Project conventions and terminology:** common components, document formats, and what specific terms mean to your team.
- **Past decisions and their reasoning:** which approaches you've chosen, when they apply, and which alternatives you've ruled out.
- **Examples you've accepted:** completed work orders, their results, and how they were verified, so the model can see what meets your team's expectations.

For now, include references to relevant docs or examples in the work order and make sure the reviewer can read them without write access. Record each source and where it applies, and update it when decisions change. Otherwise, an old answer can create a new misunderstanding. Periodically reviewing question history can also show you what belongs in the knowledge base.

Bridge plans to connect to team knowledge bases so the reviewer can retrieve past contracts, decisions, and clarifications. Keeping records doesn't yet mean automatic retrieval is available. A knowledge base gives the model something to base its judgment on; new requirements and meaningful differences still need your decision.
