// Is the node version this repository puts on a server still supported?
//
// Nothing else asks. Dependabot reads manifests, and this floor is a literal in a shell script plus
// a range in `engines`, so the version can leave support without a PR, an advisory or a red test
// saying so — the `api` matrix would sit green on an EOL runtime whose EOL is the whole problem.
// Runs weekly from .github/workflows/version-floor.yml.
//
// node's own schedule is the source, not a third party: it is the file the LTS dates are actually
// published from, so it cannot disagree with nodejs.org about when support ends.
import fs from 'node:fs'

const SCHEDULE = 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json'
const INSTALL = 'deploy/install.sh'
const PKG = 'package.json'
const CI = '.github/workflows/ci.yml'

const note = m => console.log(m)
const warn = m => console.log(`::warning::${m}`)
// Annotations, not exceptions, and no process.exit(): exiting while fetch's keep-alive socket is
// open trips a libuv teardown assertion on Windows and reports 127, which reads as "command not
// found" for what is a deliberate failure. Setting exitCode and returning ends it cleanly.
let failed = false
const fail = m => { console.log(`::error::${m}`); failed = true }

// ---------- what this repository claims ----------
function claims() {
  const install = fs.readFileSync(INSTALL, 'utf8')
  const floor = Number((install.match(/^NODE_MIN=(\d+)/m) || [])[1])
  if (!floor) return fail(`no NODE_MIN=<major> line in ${INSTALL} — the installer's floor is unreadable`)

  // `engines` is the compatibility claim and NODE_MIN is the version the installer acts on. They are
  // deliberately the same number (one floor rather than two) and both are read by someone: the
  // installer installs NODE_MIN, an operator reads `engines`.
  const engineMajor = Number((JSON.parse(fs.readFileSync(PKG, 'utf8')).engines?.node || '').match(/(\d+)/)?.[1])
  if (!engineMajor) return fail(`no engines.node in ${PKG}`)

  // The matrix is what makes either claim verifiable. A floor with no leg testing it is a promise
  // nothing checks, which is the failure this file exists to prevent — so all three agree on both
  // numbers, and a bump that forgets the matrix fails here rather than silently.
  const ci = fs.readFileSync(CI, 'utf8')
  const legs = ((ci.match(/^\s*node:\s*\[([^\]]+)\]/m) || [])[1] || '')
    .split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean)
  if (!legs.length) return fail(`no node matrix found in ${CI}`)
  const tested = new Set(legs.map(v => Number(v.split('.')[0])))
  for (const want of new Set([floor, engineMajor])) {
    if (!tested.has(want)) {
      return fail(`node ${want} is a floor (NODE_MIN=${floor} in ${INSTALL}, engines ${engineMajor} in ${PKG}) ` +
        `but no leg of the api matrix in ${CI} runs it — add '${want}' to the matrix, or the floor is a claim nothing checks`)
    }
  }
  note(`floor: node ${floor} (installer) / ${engineMajor} (engines), both tested by [${legs.join(', ')}]`)
  return floor
}

// ---------- what node says about it ----------
async function schedule() {
  const res = await fetch(SCHEDULE, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) return fail(`node's release schedule answered ${res.status} — cannot tell whether the floor is supported`)
  return res.json()
}

async function main() {
  const floor = claims()
  if (failed) return
  const entry = (await schedule())[`v${floor}`]
  if (failed) return
  if (!entry) return fail(`v${floor} is not in node's release schedule at all`)

  const today = new Date().toISOString().slice(0, 10)
  // `maintenance` is absent for a version that has not reached it; "0" is how the file spells "never".
  const maintenance = entry.maintenance && entry.maintenance !== '0' ? entry.maintenance : ''

  if (entry.end && today >= entry.end) {
    return fail(`node ${floor} went end-of-life on ${entry.end} and ${INSTALL} still installs it on new servers. ` +
      `Move NODE_MIN to a supported major and add that major to the api matrix in ${CI} in the same change — ` +
      `the matrix is what keeps the floor honest. (This does not touch a server by itself: install.sh only ` +
      `upgrades node when it is re-run.)`)
  }

  if (maintenance && today >= maintenance) {
    // Not a failure: maintenance still means security patches. It is a nudge, because what new
    // servers install should not be a version in wind-down, and the next LTS is when to move.
    warn(`node ${floor} has been in maintenance since ${maintenance} (critical fixes only, end-of-life ` +
      `${entry.end}). Still patched, so nothing is on fire — but it is what a new server installs, and the ` +
      `next LTS is the moment to move NODE_MIN and the api matrix together.`)
  } else {
    note(`node ${floor} is in active support: maintenance ${maintenance || 'not yet'}, end-of-life ${entry.end}`)
  }

  note('ok')
}

await main()
if (failed) process.exitCode = 1
