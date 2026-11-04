import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { numberProposals, openProposals, parseProposals } from '../src/proposals.js'
import { cli, sandbox } from './helpers.js'

const LEDGER = [
  '# Framework proposals',
  '',
  '## P1 · 2026-01-05 · run-a — Gate reads prose as paths',
  '',
  '**Status: shipped 2026-01-20 (abc1234) — first cell only.**',
  '',
  'Body.',
  '',
  '- Recurrence 2026-02-01 · run-c: same, on a dotted name',
  '',
  '## P2 · 2026-01-06 · run-a — Timeout reads as a failure',
  '',
  'Body.',
  '',
  '- Recurrence 2026-01-10 · run-b: again',
  '- Recurrence 2026-01-12 · run-c: again',
  '',
  '## 2026-01-07 · run-b — Help runs the command',
  '',
  '**Status: partial 2026-01-20 (abc1234) — --help fixed. Open: -h.**',
  '',
  '## 2026-01-08 · run-b — Recurrences: timeout again',
  '',
  '**Status: merged into P2 — recorded there as a recurrence.**',
  ''
].join('\n')

test('one entry per defect: recurrences are strikes; open work sorts by strikes', () => {
  const entries = parseProposals(LEDGER)
  assert.deepEqual(entries.map(e => [e.id, e.status, e.strikes]), [[1, 'shipped', 2], [2, 'open', 3], [null, 'partial', 1], [null, 'merged', 1]])
  assert.equal(entries[0].recurred_after_ship, true, 'seen again after it shipped')
  assert.equal(entries[0].status_note, 'first cell only.')
  assert.deepEqual(entries[3].merged_into, [2])
  assert.deepEqual(openProposals(entries).map(e => e.title), ['Timeout reads as a failure', 'Gate reads prose as paths', 'Help runs the command'])
})

test('numbering gives ids only to unnumbered headings, in file order, never moving one', () => {
  const { text, numbered } = numberProposals(LEDGER)
  assert.deepEqual(numbered.map(n => n.id), [3, 4])
  assert.match(text, /^## P3 · 2026-01-07 · run-b — Help runs the command$/m)
  assert.match(text, /^## P1 · 2026-01-05/m)
  assert.deepEqual(numberProposals(text).numbered, [], 'idempotent')
})

test('pipeline proposals: open list, one entry, --number writes the ids', () => {
  const { root, home } = sandbox()
  fs.mkdirSync(home, { recursive: true })
  const file = path.join(home, 'framework-proposals.md')
  fs.writeFileSync(file, LEDGER)
  const run = args => cli(args, { home, cwd: root })

  const list = run(['proposals'])
  assert.equal(list.verdict, 'OK')
  assert.deepEqual(list.open.map(e => [e.id, e.strikes]), [['P2', 3], ['P1', 2], [null, 1]])
  assert.match(list.warning, /2 heading\(s\) have no id/)
  assert.equal(list.next_id, 'P3')
  assert.deepEqual(list.tally, { shipped: 1, open: 1, partial: 1, merged: 1 })

  const one = run(['proposals', 'p2'])
  assert.equal(one.title, 'Timeout reads as a failure')
  assert.equal(one.recurrences.length, 2)

  assert.deepEqual(run(['proposals', '--number']).numbered, ['P3', 'P4'])
  assert.match(fs.readFileSync(file, 'utf8'), /^## P4 · 2026-01-08/m)
  assert.equal(run(['proposals']).warning, undefined)
  assert.equal(run(['proposals', 'P9']).verdict, 'ERROR')
})
