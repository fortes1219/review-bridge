# Work order: [one sentence describing this work]

> Copy this file and fill it in; optional fields without a value can be left empty or deleted. Keep the original wording that matters to the requirement; one acceptance result does not have to be forced onto one line. Running the start-work command authorizes the work order as it is at that moment; there is no second approval after translation.

## Basics

- Work type: [feature / defect / documentation / maintenance / other]
- Source ID: [for example a Jira key or the original link; optional]
- Product / version: [optional]
- Reporter / owner: [optional]
- Priority / due date / iteration: [optional; this is scheduling information, not a Bridge execution budget]
- Related work orders / parent work: [optional]

## Background and current state

[What is happening now? Why does it need handling this time? What is known about the current state?]

## Expected outcome

[When the work is done, what will users see or be able to do? What behavior should the system show?]

## Work

[Which changes or deliverables are required this time? Paragraphs, lists, image links or tables are all fine.]

<!--
A single piece of work needs no "Run plan" and no "RUN A".
Only when one work order starts several independent runs, copy the example below into the
work order body and fill it in.

## Run plan
- Mode: multiple runs

### RUN A: [name]
- Work: [the part this run is responsible for]
- Acceptance: [the result this run must reach; no need to number AC in advance]
- Depends on: [none / the name of another run]

### RUN B: [name; add more runs the same way when needed]
- Work: [the part this run is responsible for]
- Acceptance: [the result this run must reach]
- Depends on: [none / the name of another run]
-->

## Scope and constraints

- Includes: [situations or work this covers; optional]
- Excludes: [things this explicitly does not handle; optional]
- Must keep: [existing behavior, compatibility, permissions or data rules that must not break; optional]
- Expected locations: [files or modules likely to be touched, if known; optional. This does not authorize changing them]

## Acceptance

[Write the observable results when the whole work order is done. With multiple runs, put the cross-run overall results here and each run's own results in its run. Lists, paragraphs, tables or Given/When/Then are all fine; explanations and examples may sit next to the conditions. Translation numbers the semantically complete conditions AC1, AC2, ...]

1. [Result one, with the situations or limits it applies to]
2. [Result two, with the situations or limits it applies to]

## Verification hints (optional)

[For example a user flow to try, test data, the expected screen or existing test names. These are hints for people to check against; the actual Gate A command is chosen by Bridge from the installed rules.]

## Defect reproduction (defect work orders only)

- Environment: [device, operating system, browser, product version, etc.]
- Steps to reproduce: [step by step]
- Actual result: [what is observed now]
- Expected result: [what should happen]
- Frequency / impact: [optional]

## References, attachments and dependencies (optional)

- Reference documents / designs / code: [links or paths]
- Attachments / screenshots / samples: [links or file names]
- Dependencies / related work: [related work orders or notes]

## Open questions (optional)

[Known questions a human needs to decide. Write "none" if there are none. If translation finds an ambiguity that affects the work, Bridge stops and reports it; edit the work order and run the start-work command again.]
