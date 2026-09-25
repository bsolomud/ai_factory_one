---
# The machine-readable half of this fact: what a future run should SEARCH FOR,
# and when. `pipeline probes` matches `when:` against the files a change touches
# and hands the planner these commands, pre-formatted as '## Coupling' rows.
#
# This frontmatter is not decoration. A knowledge fact with no probe is a story:
# the plan's Coupling table can cite ONLY a command, so a lesson that cannot be
# phrased as one is a lesson that will never be applied again. Measured before
# probes existed: 10 facts accumulated across 29 runs, none carrying a command,
# and not one of them was ever cited by the section they were written to inform.
#
# `run:` comes in two tiers, and which one you write decides what it produces:
#
#   coupling — a read-only SEARCH (`git grep`, `grep`, `rg`). Its hit count
#              becomes a '## Coupling' row, and the gate RE-RUNS the command and
#              compares, so it is held to exactly what the gate accepts.
#   inspect  — a read-only INSPECTION (`git log`/`rev-list`/`diff`/`show`/
#              `status`/`ls-files`/`blame`, `gh pr|run|issue view`). Answers a
#              question that no search can — "is this PR conflicting, so every
#              workflow is being skipped?", "is this branch far enough ahead that
#              the lint gate will flood?" — and produces no row.
#
# No shell operators in either tier: a probe is a command the pipeline hands an
# agent to run unattended. Anything else is reported by `pipeline probes --lint`
# and never offered.
#
# When the fact genuinely has no searchable shape — a triage method applied to a
# screenshot, an environment cost that belongs in `commands.env_checks` — DECLARE
# it instead of leaving the field out:
#
#   probe: none
#   probe_none: "why no command can express this"
#
# A declared omission is a decision and `--lint` accepts it; a missing one is an
# oversight and `--lint` reports it. The reason is what separates them, which is
# the same rule the Coupling gate applies to a bare "None." Never invent a
# command that finds nothing just to fill the field.
probe:
  - when: ["<glob the change must touch, e.g. app/**/*.rb — use ['**'] for a fact about any change>"]
    run: "git grep -n <symbol> -- <roots>"
    asks: "<what a hit MEANS — 'who else writes this?', 'does an implicit scope make this query lie?'>"
taught_by: "<run id / PR that paid for this lesson>"
---

# <The fact, as a sentence someone can act on>

<!-- 1-3 sentences. State the thing that is true about this repo, not the story
     of discovering it. Write it so a reader who has never seen the incident can
     apply it to a change they are planning right now. -->

## Why
<!-- The consequence of not knowing it — what actually broke, or would break.
     This is what makes the fact worth reading; a fact without a cost attached
     gets skimmed past. -->

## Evidence
<!-- The run id, and the file / PR / event that proves it. Anyone re-checking
     this fact in six months starts here. -->
