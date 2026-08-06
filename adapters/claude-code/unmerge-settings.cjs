const fs = require('fs')
const file = process.env.SETTINGS
if (!fs.existsSync(file)) process.exit(0)
let settings
try { settings = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { process.exit(0) }

// --- hooks: remove ONLY our guard entries, prune empties ---
const guardBin = process.env.GUARD_BIN
const isOurHook = cmd => typeof cmd === 'string' &&
  (cmd === `${guardBin} bash` || cmd === `${guardBin} write` ||
   /ai_factory_one\/bin\/guard (bash|write)$/.test(cmd))

let removed = 0
const hooks = settings.hooks?.PreToolUse
if (Array.isArray(hooks)) {
  settings.hooks.PreToolUse = hooks
    .map(entry => {
      const kept = (entry.hooks || []).filter(h => { if (isOurHook(h.command)) { removed++; return false } return true })
      return { ...entry, hooks: kept }
    })
    .filter(entry => (entry.hooks || []).length > 0)
  if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks
}

// --- permissions: remove ONLY our unambiguous ai_factory_one rules. We do
// NOT strip the generic Bash(echo:*) / Bash(pipeline:*) — a user may rely on
// those independently; leaving them is the safe (harmless) choice. ---
const isOurRule = r => typeof r === 'string' && /ai_factory_one/.test(r)
if (settings.permissions?.allow) {
  settings.permissions.allow = settings.permissions.allow.filter(r => !isOurRule(r))
  if (settings.permissions.allow.length === 0) delete settings.permissions.allow
}
if (settings.permissions?.additionalDirectories) {
  settings.permissions.additionalDirectories = settings.permissions.additionalDirectories.filter(d => !/ai_factory_one/.test(d))
  if (settings.permissions.additionalDirectories.length === 0) delete settings.permissions.additionalDirectories
}
if (settings.permissions && Object.keys(settings.permissions).length === 0) delete settings.permissions

fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')
console.log(`removed ${removed} guard hook(s) from ${file}`)
