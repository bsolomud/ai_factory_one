import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { appendEvent, newState, readEvents, readState, StateError, writeState } from '../src/state.js'
import { sandbox } from './helpers.js'

test('write → read round-trips and leaves no tmp file', () => {
  const { root } = sandbox()
  const state = newState({ runId: 'T-1', repo: 'r', stage: 'CONTEXT' })
  writeState(root, state)
  assert.deepEqual(readState(root), state)
  assert.ok(!fs.existsSync(path.join(root, 'state.json.tmp')))
})

test('missing state throws StateError', () => {
  const { root } = sandbox()
  assert.throws(() => readState(root), StateError)
})

test('corrupt json throws StateError, not SyntaxError', () => {
  const { root } = sandbox()
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'state.json'), '{ "stage": "PL')
  assert.throws(() => readState(root), StateError)
})

test('missing required key throws StateError', () => {
  const { root } = sandbox()
  const state = newState({ runId: 'T-1', repo: 'r', stage: 'CONTEXT' })
  delete state.gates
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(state))
  assert.throws(() => readState(root), /missing required key 'gates'/)
})

test('events append-only; torn final line tolerated', () => {
  const { root } = sandbox()
  appendEvent(root, { event: 'run_created', run: 'T-1' })
  appendEvent(root, { event: 'gate_approved', stage: 'CONTEXT' })
  fs.appendFileSync(path.join(root, 'events.jsonl'), '{"event": "torn')
  const events = readEvents(root)
  assert.equal(events.length, 2)
  assert.equal(events[1].event, 'gate_approved')
  assert.ok(events[0].at, 'events are timestamped')
})
