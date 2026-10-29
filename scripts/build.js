// Bundle bin/pipeline and bin/guard into self-contained dist/ executables
// (the only runtime dep, the YAML parser, is baked in — zero npm install for users).
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'
import { toolVocabulary } from '../src/nda.js'

mkdirSync('dist', { recursive: true })

for (const [entry, out] of [['bin/pipeline', 'dist/pipeline'], ['bin/guard', 'dist/guard']]) {
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: { js: '#!/usr/bin/env node\nimport { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    target: 'node18',
    logLevel: 'error'
  })
  // esbuild re-emits the entry file's own hashbang below our banner — a second
  // shebang mid-file is a syntax error. Keep only the banner's (line 1).
  const bundled = readFileSync(out, 'utf8').split('\n')
  writeFileSync(out, bundled.filter((line, i) => i === 0 || !line.startsWith('#!')).join('\n'))
  chmodSync(out, 0o755)
  console.log(`built ${out}`)
}

// The NDA check's allowlist is the tool's own text; the bundle has no sources
// to read it from, so it ships alongside (installed as <home>/vocabulary.json).
const vocab = toolVocabulary(process.cwd())
writeFileSync('dist/vocabulary.json', JSON.stringify({ words: [...vocab.words].sort(), shipped: [...vocab.shipped].sort() }) + '\n')
console.log(`built dist/vocabulary.json (${vocab.words.size} words)`)
