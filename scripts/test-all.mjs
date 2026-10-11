/**
 * Run every offline suite in one command.
 *
 *     node scripts/test-all.mjs [--only <name>]
 *
 * These are the checks that need no network and spend no account quota: each one
 * mounts the real module against a local stand-in. The live end-to-end run — a
 * real profile, a real channel login — is a deliberate act and is not here.
 *
 * Upstream ran 45 suites over the free lane, the co-paid lane, the aggregate
 * lane, the token savers and the standalone product. This fork keeps the ones
 * that still have a subject: the browser half's registration/copy/style
 * contracts, the host's whole HTTP surface, the request fence, the egress
 * outlet, the gateway relay, and the absorbed channel pack itself.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = fileURLToPath(new URL('.', import.meta.url))
const options = { only: null }
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index]
  if (flag !== '--only' || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
    console.error(`usage: node scripts/test-all.mjs [--only <name>] (invalid ${flag})`)
    process.exit(1)
  }
  options[flag.slice(2)] = process.argv[++index]
}
const { only } = options

const suites = [
  // The browser half: it registers, every copy key exists in both languages, and
  // every style rule it declares is reachable from the code.
  ['client-lint', 'client-lint.mjs', []],
  // The host half: the whole /api/our-free-model surface, mounted offline, plus
  // the routes the removed features must no longer answer.
  ['host-smoke', 'host-smoke-test.mjs', []],
  // The host modules that carry their own contracts.
  ['trust', 'trust-test.mjs', []],
  ['chan-relay', 'chan-relay-test.mjs', []],
  ['egress', 'egress-test.mjs', []],
  // The absorbed pack: mount, provider set, credits, image pricing, proxy rules.
  ['channel-pack', 'channel-pack-test.mjs', []],
  ['channel-network', 'channel-network-test.mjs', []],
].filter(([name]) => only === null || name.startsWith(only))

if (only !== null && suites.length === 0) {
  console.error(`--only "${only}" selected no suite`)
  process.exit(1)
}

/**
 * A suite that hangs must leave enough output to identify where it stopped.
 *
 * One of upstream's suites bound a fixed port, lost the race to a suite running
 * beside it, and then sat in a `fetch` whose socket nobody answered — three
 * minutes of the runner's own ceiling, after which it printed six `ok` lines as
 * the "failure detail" because buffered child output was unavailable. The
 * deadline is well above the slowest suite, and live output now identifies the
 * last check seen.
 */
const SUITE_TIMEOUT_MS = 60_000

/**
 * Run a suite while forwarding its output as it arrives. Keeping the output
 * live is important here: a timeout kills the child before a buffered pipe can
 * be read, which erases the last check the suite printed.
 */
function runSuite(script, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(scriptsDir, script), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let forceKillTimer
    let spawnError = null
    const started = Date.now()
    const forward = (stream, chunk) => {
      const text = chunk.toString()
      stream === 'stdout' ? stdout += text : stderr += text
      process[stream].write(text)
    }
    child.stdout.on('data', chunk => forward('stdout', chunk))
    child.stderr.on('data', chunk => forward('stderr', chunk))
    const deadline = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return
      timedOut = true
      child.kill()
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 500)
    }, SUITE_TIMEOUT_MS)
    child.once('error', error => {
      spawnError = error
    })
    child.once('close', (status, signal) => {
      clearTimeout(deadline)
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer)
      resolve({ error: spawnError, signal, status, stdout, stderr, ms: Date.now() - started, timedOut })
    })
  })
}

const results = []
console.log('test mode: offline suites only')
for (const [name, script, args] of suites) {
  const run = await runSuite(script, args)
  const output = `${run.stdout}${run.stderr}`.trimEnd().split('\n')
  const hung = run.timedOut || run.error !== null || run.signal !== null
  const ok = !hung && run.status === 0
  results.push({ name, ok, ms: run.ms, output })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(14)} ${String(run.ms).padStart(5)} ms`)
  if (!ok) {
    if (run.timedOut) console.log(`       killed at the ${SUITE_TIMEOUT_MS / 1000}s deadline — the live output above is the last diagnostic from the suite`)
    else if (hung) console.log(`       never finished (${run.error?.message ?? `signal ${run.signal}`})`)
    const detail = output.filter(line => /^(FAIL|✗|Error|error:)/.test(line.trim())).slice(0, 6)
    for (const line of (detail.length > 0 ? detail : output.slice(-12))) console.log(`       ${line}`)
  }
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} suites passed${failed.length > 0 ? ` — ${failed.map(f => f.name).join(', ')} failed` : ''}`)
process.exitCode = failed.length === 0 ? 0 : 1
