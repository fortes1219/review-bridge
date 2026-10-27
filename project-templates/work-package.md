---
# Every key is optional; delete what you do not need. Any other key is refused.
# priority: medium        # low / medium / high / urgent; picks the models and effort from the policy's table
# effort: medium          # low / medium / high; the writer's effort for every writer call
# budget:                 # each key optional; each may only be lower than the policy's limit
#   tokens: 2000000
#   tokens_per_call: 150000
#   call_timeout: 1200000 # milliseconds
#   test_timeout: 600000  # milliseconds
#   run_timeout: 7200000  # milliseconds
#   rounds: 2
# source_id: SHOP-412     # your own tracker's id; Bridge stores it and never reads it
---
# [One sentence describing this work]

> Copy this file and fill in the blocks you need; delete the ones you do not. Each block runs from its `<!-- bridge:... -->` line to the next one, and Bridge copies it into the contract field of that name as written. The `##` headings are for you, in any language; Bridge does not read them. Running the start-work command authorizes the work order as it is at that moment.

<!-- bridge:context -->
## Background and current state
[What is happening now? Why does it need handling this time?]

<!-- bridge:outcome -->
## Expected outcome
[When the work is done, what will users see or be able to do?]

<!-- bridge:requested_work -->
## Work
[Which changes or deliverables are required this time? Paragraphs, lists, image links or tables are all fine.]

<!-- bridge:run_plan -->
## Run plan (only for two or more runs; leave this block empty for one piece of work)

<!-- bridge:scope_notes.include -->
## Includes
[Situations or work this covers]

<!-- bridge:scope_notes.exclude -->
## Excludes
[Things this explicitly does not handle]

<!-- bridge:scope_notes.must_keep -->
## Must keep
[Existing behavior, compatibility, permissions or data rules that must not break]

<!-- bridge:scope_notes.expected_locations -->
## Expected locations (context only; this does not authorize changing them)
[Files or modules likely to be touched, if known]

<!-- bridge:acceptance -->
## Acceptance
1. [Result one, with the situations or limits it applies to]
2. [Result two, with the situations or limits it applies to]

<!-- bridge:verification_hints -->
## Verification hints (the test command itself is chosen by Bridge from the installed rules)
[A user flow to try, test data, the expected screen or existing test names]

<!-- bridge:reproduction.environment -->
## Defect: environment
[Device, operating system, browser, product version]

<!-- bridge:reproduction.steps -->
## Defect: steps to reproduce
1. [Step one]

<!-- bridge:reproduction.actual -->
## Defect: actual result
[What is observed now]

<!-- bridge:reproduction.expected -->
## Defect: expected result
[What should happen]

<!-- bridge:reproduction.frequency -->
## Defect: frequency and impact
[How often, and who is affected]

<!-- bridge:references -->
## References, attachments and dependencies
- [Links, paths, designs, related work orders]

<!-- bridge:open_questions -->
## Open questions (write "none" if there are none; every other line is a question that stops the work for you)
none
