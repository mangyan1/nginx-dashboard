// The docs make claims nothing checks, and two kinds of them rot silently because the prose
// still reads fine: a command a reader is told to run, and a version number that lives in a
// shell script rather than in a manifest.
//
// Both were wrong at once when this was written — ARCHITECTURE.md said to run `npm run guard`
// (never a script, so it exited "Missing script: guard"), and three docs still named node 22 as
// the floor after it moved to 24. Neither is visible to any other test: the suites test code,
// and a doc's claims are only ever read by a human, who trusts them.
//
// Deliberately narrow. It checks the two claim shapes that are mechanically decidable rather
// than the whole prose, because a check that guesses at sentences fails on a rephrasing and
// gets deleted. Numbers that only drift — "47 checks passed" — are kept out of the docs instead.
import fs from 'node:fs'

// The tracked docs, plus the ops notes, which are gitignored: a clone has neither, so they are
// skipped rather than reported missing.
const DOCS = ['README.md', 'deploy/README.md', 'AGENT.md', 'ARCHITECTURE.md', 'GUARDRAIL.md']

// npm's own commands, which are not this project's scripts and are correct as written.
const NPM_BUILTINS = new Set([
  'install', 'i', 'ci', 'audit', 'ls', 'list', 'update', 'outdated', 'fund', 'exec', 'init',
  'run', 'version', 'why', 'view', 'help', 'cache', 'config', 'prune', 'dedupe', 'pack',
  'publish', 'link', 'root', 'prefix', 'doctor', 'rebuild', 'restart', 'stop', 'uninstall',
  'rm', 'remove', 'start',
])

const scripts = Object.keys(JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts)
const floor = (fs.readFileSync('deploy/install.sh', 'utf8').match(/^NODE_MIN=(\d+)/m) || [])[1]

let failed = false
const fail = m => { console.log(`::error::${m}`); failed = true }

if (!floor) fail('no NODE_MIN=<major> in deploy/install.sh — nothing to check the docs against')

for (const doc of DOCS) {
  if (!fs.existsSync(doc)) continue
  fs.readFileSync(doc, 'utf8').split('\n').forEach((line, i) => {
    const at = `${doc}:${i + 1}`

    // Anything the reader would type — which means a code span, or a line that starts a
    // command (optionally behind `VAR=x` assignments, since the docs prefix DASH_* that way).
    // Prose is not a command: "the npm registry" and "npm moving one on the server" are
    // sentences, and a check that reads them as invocations is a check someone deletes.
    const candidates = [...line.matchAll(/`([^`]+)`/g)].map(m => m[1])
    if (/^\s*(?:[A-Z_]+=\S*\s+)*npm\s/.test(line)) candidates.push(line)

    // …, and nothing may follow the name but the end of the line, whitespace or a comment.
    // That last part is what separates an invocation from a sentence: the wrapped prose line
    // "npm registry when that tab is opened" starts with `npm` and is not a command.
    for (const candidate of candidates) {
      for (const [, name, rest] of candidate.matchAll(/\bnpm (?:run )?([a-z][\w:-]*)(.*)$/gm)) {
        if (!/^\s*(?:#.*)?$/.test(rest.replace(/\\$/, ''))) continue
        if (NPM_BUILTINS.has(name) || scripts.includes(name)) continue
        fail(`${at}: tells the reader to run \`npm ${name}\`, which is not a script in package.json (${scripts.join(', ')})`)
      }
    }

    // A node version stated as the floor has to be the floor — `Node ≥ 24`, or the
    // "(`NODE_MIN`, 24 here)" form deploy/README.md used.
    for (const m of line.matchAll(/\b[Nn]ode\s*(?:≥|>=)\s*(\d+)|NODE_MIN`?,\s*(\d+)/g)) {
      const stated = m[1] || m[2]
      if (stated !== floor) fail(`${at}: says node ${stated}, but NODE_MIN is ${floor} in deploy/install.sh`)
    }
  })
}

console.log(failed ? 'docs claims: FAILED' : 'docs claims: ok — every command exists and the floor matches')
if (failed) process.exitCode = 1
