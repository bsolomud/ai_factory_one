const fs = require('fs')
const file = process.env.SETTINGS
const guardBin = `${process.env.PIPELINE_HOME}/bin/guard`
let settings = {}
if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, 'utf8'))
settings.hooks ??= {}
settings.hooks.PreToolUse ??= []
const wanted = [
  { matcher: 'Bash', cmd: `${guardBin} bash` },
  { matcher: 'Edit|Write|NotebookEdit', cmd: `${guardBin} write` }
]
for (const { matcher, cmd } of wanted) {
  const present = settings.hooks.PreToolUse.some(entry =>
    (entry.hooks || []).some(h => h.command === cmd))
  if (!present) settings.hooks.PreToolUse.push({ matcher, hooks: [{ type: 'command', command: cmd }] })
}

// Session-scoped engagement: a `/pipeline` prompt MARKS the session; session end
// UNMARKS it. The PreToolUse guard only enforces for marked sessions, so a
// leftover active run never forces pipeline behavior on a session that never
// ran /pipeline. Matcher-less events — merged and deduped like the above.
const eventHooks = [
  { event: 'UserPromptSubmit', cmd: `${guardBin} mark` },
  { event: 'SessionEnd', cmd: `${guardBin} unmark` }
]
for (const { event, cmd } of eventHooks) {
  settings.hooks[event] ??= []
  const present = settings.hooks[event].some(entry => (entry.hooks || []).some(h => h.command === cmd))
  if (!present) settings.hooks[event].push({ hooks: [{ type: 'command', command: cmd }] })
}

// Pre-approve the pipeline's own CLI + reading its home, so /pipeline never
// prompts for its own machinery. Absolute (as invoked by hooks) + ~ form (as
// the SKILL invokes it). Merged, deduped — user's own rules are untouched.
const home = process.env.PIPELINE_HOME
settings.permissions ??= {}
settings.permissions.allow ??= []
const allowWanted = [
  `Bash(${home}/bin/pipeline:*)`,
  'Bash(~/.ai_factory_one/bin/pipeline:*)',
  'Bash(pipeline:*)',
  'Bash(echo:*)',
  `Read(${home}/**)`,
  'Read(~/.ai_factory_one/**)'
]
for (const rule of allowWanted) if (!settings.permissions.allow.includes(rule)) settings.permissions.allow.push(rule)
settings.permissions.additionalDirectories ??= []
for (const dir of [home, '~/.ai_factory_one']) {
  if (!settings.permissions.additionalDirectories.includes(dir)) settings.permissions.additionalDirectories.push(dir)
}

fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')
console.log(`hooks + permissions merged into ${file}`)
