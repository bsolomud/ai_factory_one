# ai_factory_one — Pilot Playbook

How to run the pipeline on real work and produce evidence about whether it
helps. Read this once before your first ticket.

## Before the pilot (one-time setup)

1. **Install**: `./install.sh --claude` (from this repo). Open a NEW Claude
   Code session afterward so the skill and hooks load.
2. **Onboard each pilot repo**: in a session, `/pipeline onboard <path>`.
   Answer the interview; choose skill bindings (use-repo / use-built-in /
   both per capability). Confirm the profile.
3. **Sanity-check the profile**: `/pipeline doctor` — fix any errors before
   starting real work.
4. **Calibrate the critic and reviewer** (do this once, it protects every
   later run): hand the critic 2–3 plans you know are flawed and 1 you know is
   good; confirm it flags the real problems and doesn't manufacture noise on
   the good one. Same for the reviewer with a known-bad and known-good diff.
   If it rubber-stamps or cries wolf, tell the maintainer — the agent prompt
   needs tuning before the pilot is meaningful.

## Running one ticket

1. `/pipeline start <ticket-id | link | paste the task>`
   - It researches, then **asks you questions**. Answer them like you would a
     junior engineer — this is where scope and "done" get pinned down.
   - It writes context + **acceptance criteria**. Read them. If they're wrong,
     say so; if you tweak them yourself, that's fine (it's tracked).
2. Review at the gate → **approve** (or ask for changes). Say approve in your
   own words; the pipeline records it.
3. `/pipeline work` — repeat. Each call advances one stage: plan → your
   approval → breakdown → implement (one subtask at a time, each gated) →
   tests → review → PR → CI → retro.
4. At any gate you can:
   - `/pipeline show` — see the current artifact/diff again.
   - `/pipeline feedback "<what felt off or great>"` — capture your reaction
     the moment you have it. **Do this often** — it's the pilot's raw data.
   - request changes instead of approving — the relevant agent redoes the work.
5. `/pipeline status` any time to see where you are.
6. Abandon a dead-end run with `/pipeline abort`.

## What to watch for (and report via feedback)

- **Context stage**: were the questions the right ones? Did the acceptance
  criteria match what you actually wanted?
- **Plan**: correct files? Did the critic catch anything real? Did you have to
  fix the plan before approving?
- **Implementation**: did diffs pass lint+tests on first presentation, or bounce?
- **Overall**: did this save you time versus doing it yourself, or cost more?

## Reading the results

After a few tickets: `/pipeline metrics` (per repo). The headline numbers:

| Metric | What it tells you | Good direction |
| --- | --- | --- |
| `first_pass_green_rate` | share of stages that passed validators with no retry | higher |
| `gate_edit_rate` | share of gates where you had to change the artifact | lower |
| `blocked_by_stage` | where the AI most often fails the checks | find the hot spot |
| `critic_rounds` | how hard the plan critic worked | non-zero = it's engaging |
| `agents_spawned` | cost proxy per run | watch for runaway |
| `feedback_notes` | your captured reactions | more = better evidence |

**Go/no-go signal**: rising first-pass-green rate and falling gate-edit rate
across the pilot = the pipeline is producing trustworthy work. Flat-high
gate-edit rate = the AI's output isn't ready to trust yet; read the feedback
notes to see why.

## Known limits during pilot v1 (don't report these as bugs)

- **Multi-repo features** aren't supported — run each repo as a separate ticket.
- **Onboarding is manual** — no lockfile auto-detection yet; you type the
  commands (they're verified by running once).
- **Token counts** aren't measured directly; `agents_spawned` is the cost
  proxy. The ≤30-line agent-summary discipline is prompt-enforced — if you
  ever see an agent dump a whole file back into the chat, capture it with
  `/pipeline feedback` so we can tighten the prompt.
- **Approval is protocol-enforced, not hook-blocked**: the model must get your
  explicit yes, and every approval is in the audit log — check `metrics` /
  the events log if you ever suspect a self-approval.
