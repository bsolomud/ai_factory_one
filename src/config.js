import fs from 'node:fs'
import YAML from 'yaml'
import { asset } from './paths.js'

// pipeline.yml is the FSM in data. It must stay repo-agnostic: capability slots
// only, zero concrete commands (enforced by test/agnostic-lint.test.js).
export function loadPipeline(file = asset('pipeline.yml')) {
  const doc = YAML.parse(fs.readFileSync(file, 'utf8'))
  if (!doc || typeof doc.stages !== 'object') throw new Error(`${file}: missing 'stages' map`)
  const names = Object.keys(doc.stages)
  const first = names[0]
  for (const [name, def] of Object.entries(doc.stages)) {
    if (!def.next) throw new Error(`pipeline.yml: stage ${name} has no 'next'`)
    if (def.next !== 'DONE' && !doc.stages[def.next]) {
      throw new Error(`pipeline.yml: stage ${name} points to unknown stage '${def.next}'`)
    }
  }
  return { stages: doc.stages, first, order: chainOrder(doc.stages, first) }
}

function chainOrder(stages, first) {
  const order = []
  let cur = first
  const seen = new Set()
  while (cur && cur !== 'DONE') {
    if (seen.has(cur)) throw new Error(`pipeline.yml: cycle at stage ${cur}`)
    seen.add(cur)
    order.push(cur)
    cur = stages[cur].next
  }
  return order
}

export function stageDef(config, name) {
  const def = config.stages[name]
  if (!def) throw new Error(`unknown stage '${name}'`)
  return def
}

// Map an output artifact path back to its stage (reconcile uses this).
export function stageForArtifact(config, artifactRel) {
  for (const [name, def] of Object.entries(config.stages)) {
    if (def.output === artifactRel) return name
  }
  return null
}
