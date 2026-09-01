#!/usr/bin/env node

/**
 * The same real-model lane as `model-e2e.mjs`, aimed at a real application.
 *
 * The deterministic fixture proves the mechanism: it is built to be readable,
 * it exposes a status line that names the pointer phase it received, and it
 * never fights for the foreground. Real applications do none of that, and
 * every failure this project has actually shipped was found against one:
 *
 *   - the agent cursor froze after its first placement, visible only in a
 *     live session because the fixture suite drove it with durationMs: 0
 *   - Notes lost its window id to a title comparison, which silently skipped
 *     the whole cursor path without reporting anything
 *   - a Chromium application answered an accessibility tree of one element
 *
 * So this lane asserts the three properties a user would notice, and measures
 * each one from outside the plugin rather than believing its own return codes:
 *
 *   never activated      the frontmost application is sampled throughout and
 *                        must never become the target
 *   no global pointer    no pointer event on the system stream may originate
 *                        from this project, which is what moving the user's
 *                        own cursor would require
 *   agent cursor moved   the overlay panel must be seen at more than one
 *                        position, which is what "frozen cursor" violated
 *
 * The pointer property is measured by source attribution rather than by
 * watching the cursor sit still: a person using the machine while the lane
 * runs moves the cursor hundreds of pixels, and an assertion that a human must
 * hold still is an assertion that will be silenced rather than believed.
 *
 * More than one target is required, and that is not padding: with a single
 * click the overlay can only ever be seen at one position, so the frozen
 * cursor this lane exists to catch would pass.
 *
 * Usage:
 *     DEEPSEEK_API_KEY=... node scripts/real-app-e2e.mjs \
 *       --bundle com.apple.calculator --name Calculator \
 *       --target 'the key labelled "7"' --target 'the key labelled "8"'
 *
 * `--target` is prose handed to the model: naming the element is the model's
 * job, and prescribing an index would test the harness instead of the model.
 * It installs the published tarball for this package's version into a DSH home
 * of its own, so it measures what a user would install rather than the working
 * tree; pass `--plugin <tgz>` to test a candidate build instead.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const HELPER = join(ROOT, 'native', 'macos', 'bin', 'dsh-computer-use-helper')
const MONITOR = join(ROOT, 'native', 'macos', 'fixture', 'dsh-computer-use-input-monitor')
const LIMITS = { maxNodes: 1500, maxDepth: 25, maxTextBytes: 128000 }

/** How long each monitor window runs. Short enough to notice the overlay appearing. */
const SAMPLE_WINDOW_MS = 4_000

function parseArgs(argv) {
  const options = { bundle: undefined, name: undefined, targets: [], plugin: undefined, output: undefined, window: undefined }
  const values = [...argv]
  while (values.length > 0) {
    const option = values.shift()
    const key = {
      '--bundle': 'bundle', '--name': 'name', '--target': 'targets',
      '--plugin': 'plugin', '--output': 'output', '--window': 'window',
    }[option]
    if (key === undefined) throw new Error(`unknown option: ${option}`)
    const value = values.shift()
    if (value === undefined) throw new Error(`${option} needs a value`)
    if (key === 'targets') options.targets.push(value)
    else options[key] = key === 'output' || key === 'plugin' ? resolve(value) : value
  }
  for (const required of ['bundle', 'name']) {
    if (options[required] === undefined) throw new Error(`--${required} is required`)
  }
  if (options.targets.length < 2) throw new Error('at least two --target values are required; see the header')
  return options
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for the real-model lane`)
  return value
}

function run(command, args, { cwd, env, timeoutMs = 120_000, input } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: env === undefined ? process.env : { ...process.env, ...env },
      // Detached makes the child its own process group leader, which is what
      // the helper's anti-tampering guard requires of a managed parent.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); rejectRun(new Error(`${command} timed out`)) }, timeoutMs)
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value })
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value })
    child.once('error', error => { clearTimeout(timer); rejectRun(error) })
    child.once('close', code => { clearTimeout(timer); resolveRun({ code, stdout, stderr }) })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

/**
 * The pid of a running application, asked of the window server by bundle id.
 *
 * Deliberately not `pgrep -f`: a command line that merely mentions the target
 * is not the target, and the first thing such a pattern matches is this very
 * script, whose arguments contain the bundle id.
 */
async function applicationPid(bundle) {
  const { stdout } = await run('osascript', [
    '-e', `tell application "System Events" to get unix id of first process whose bundle identifier is "${bundle}"`,
  ]).catch(() => ({ stdout: '' }))
  const pid = Number(stdout.trim())
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

/**
 * Processes owned by this project right now, matched on the full command line.
 *
 * Returns the overlay separately because the sampler aims at its window, and
 * every helper pid because pointer events are attributed by source pid: an
 * event the lane cannot attribute to us is an event we did not send.
 */
async function ourProcesses() {
  const { stdout } = await run('ps', ['-axo', 'pid=,command='])
  const helpers = []
  let overlay
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
    if (match === null) continue
    const [, pid, command] = match
    if (!command.includes('dsh-computer-use-helper')) continue
    helpers.push(Number(pid))
    if (command.includes('--cursor-overlay')) overlay = Number(pid)
  }
  return { helpers, overlay }
}

/** One helper round trip. Returns the envelope as the helper wrote it. */
async function helper(request) {
  const { stdout, stderr } = await run(HELPER, [], { input: `${JSON.stringify({ protocolVersion: 1, ...request })}\n` })
  try { return JSON.parse(stdout) }
  catch { throw new Error(`invalid helper JSON: ${stdout || stderr}`) }
}

async function observe(app) {
  const envelope = await helper({ command: 'observe', app, options: { screenshot: 'none', ...LIMITS } })
  if (!envelope.ok) throw new Error(`${envelope.error?.code}: ${envelope.error?.message}`)
  return envelope.value
}

/** Launch the target without foreground activation and wait until it is observable. */
async function resolveTarget(bundle, name) {
  await run('open', ['-g', '-b', bundle], { timeoutMs: 20_000 })
  const deadline = Date.now() + 20_000
  let lastError = 'never became observable'
  let latest
  while (Date.now() < deadline) {
    const pid = await applicationPid(bundle)
    if (pid !== undefined) {
      const app = { bundleId: bundle, pid, name }
      try {
        const observation = await observe(app)
        // Wait for the window id too, not just a frame: a freshly launched
        // application reports its frame first, and reading it in that gap
        // looks exactly like the defect where an id is never exposed at all.
        if (observation.app.bundleId === bundle && observation.window.frame.width > 0
          && observation.window.id !== undefined) return { app, observation }
        latest = observation
        lastError = 'exposed a window but never a window id'
      } catch (error) { lastError = error.message }
    }
    await delay(250)
  }
  // An application that is observable but never yields an id is a finding, not
  // a reason to abandon the run: it is precisely the Notes defect.
  if (latest !== undefined) return { app: { bundleId: bundle, pid: latest.app.pid, name }, observation: latest }
  throw new Error(`${bundle} ${lastError}`)
}

/**
 * Make one of the target's windows the focused one, without activating it.
 *
 * An observation reads whichever window the application has focused, and a
 * real application usually has several. Raising the wanted one is the setup a
 * person would do by clicking it -- except that clicking would also bring the
 * application forward, which is the thing under test. `AXRaise` does not:
 * verified by watching the frontmost application stay put across the call.
 */
async function focusWindow(bundle, title) {
  const { code, stderr } = await run('osascript', [
    '-e', `tell application "System Events" to tell (first process whose bundle identifier is "${bundle}")`
      + ` to perform action "AXRaise" of (first window whose name is "${title}")`,
  ])
  if (code !== 0) throw new Error(`could not raise the window "${title}": ${stderr.trim().slice(-300)}`)
}

/**
 * Sample the machine for as long as `until` stays unresolved.
 *
 * The monitor takes its duration up front and prints only when it ends, so a
 * single long window could not report the overlay's pid appearing partway
 * through. Rolling short windows can, and re-aiming each new window at the
 * overlay is what turns "the panel exists" into "the panel moved".
 */
async function sampleThroughout(until) {
  const windows = []
  const overlayFrames = []
  const ourPids = new Set()
  let done = false
  until.finally(() => { done = true })
  while (!done) {
    const { helpers, overlay } = await ourProcesses()
    for (const pid of helpers) ourPids.add(pid)
    const args = ['--duration-ms', String(SAMPLE_WINDOW_MS), '--interval-micros', '3000']
    if (overlay !== undefined) args.push('--window-owner-pid', String(overlay))
    const { stdout } = await run(MONITOR, args, { timeoutMs: SAMPLE_WINDOW_MS + 10_000 })
    const line = stdout.trim().split(/\r?\n/u).pop()
    let payload
    try { payload = JSON.parse(line) } catch { continue }
    windows.push(payload)
    // Every position the panel occupied during the window, not just where it
    // happened to be when the window ended: the overlay is shown briefly per
    // action, so end-of-window sampling catches it at most once per action and
    // usually not at all.
    if (overlay !== undefined) overlayFrames.push(...(payload.observedWindowOrigins ?? []))
  }
  return { windows, overlayFrames, ourPids }
}

function summarise(samples, targetPid, ourPids) {
  const { windows, overlayFrames } = samples
  const frontmostPids = [...new Set(windows.flatMap(window => window.observedFrontmostPids ?? []))]
  const positions = [...new Set(overlayFrames.map(frame => `${frame.x},${frame.y}`))]
  const pointerSources = {}
  for (const window of windows) {
    for (const [pid, count] of Object.entries(window.pointerEventSourceCounts ?? {})) {
      pointerSources[pid] = (pointerSources[pid] ?? 0) + count
    }
  }
  return {
    sampleWindows: windows.length,
    samples: windows.reduce((total, window) => total + (window.samples ?? 0), 0),
    frontmostPids,
    targetEverFrontmost: frontmostPids.includes(targetPid),
    pointerEventSources: pointerSources,
    ourGlobalPointerEvents: [...ourPids].reduce((total, pid) => total + (pointerSources[String(pid)] ?? 0), 0),
    // Source pid 0 is hardware: the person at the machine. Reported because a
    // busy human explains a foreground change that would otherwise read as the
    // plugin stealing focus, and the reader deserves to see which it was.
    humanPointerEvents: pointerSources['0'] ?? 0,
    // Informational only: a person using the machine moves this, so it proves
    // nothing on its own. Attribution above is the assertion.
    observedCursorTravel: Math.max(0, ...windows.map(window => window.maximumCursorDistance ?? 0)),
    agentCursorPositions: positions,
  }
}

async function screenshots(workspace) {
  const root = join(workspace, '.dsh-computer-use', 'artifacts')
  const found = []
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith('.png')) found.push(path)
    }
  }
  await walk(root)
  return found
}

/**
 * A DSH home of our own, holding nothing but the plugin under test.
 *
 * Running against the developer's real home looked closer to a real trial and
 * is not: it inherits whatever else is installed there, writes session history
 * the user did not ask for, and fails outright on a credentials file this
 * build parses more strictly than the one that wrote it. An empty home plus
 * the published tarball is both isolated and closer to what a user installs.
 */
async function prepareHome(pluginTarball) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-computer-real-home-'))
  const install = await run('dsh', ['plugin', '--profile', 'headless', 'add', pluginTarball], {
    env: { DSH_HOME: home }, timeoutMs: 180_000,
  })
  if (install.code !== 0) throw new Error(`installing ${pluginTarball} failed: ${install.stderr.slice(-800)}`)
  const dump = await run('dsh', ['--profile', 'headless', '--dump-config'], { env: { DSH_HOME: home }, timeoutMs: 60_000 })
  if (!dump.stdout.includes("name: '@anionex/dsh-computer-use'")) {
    throw new Error('the prepared Profile does not mount dsh-computer-use')
  }
  return home
}

/** The published tarball for this package's version, unless one was supplied. */
async function resolvePlugin(options, into) {
  if (options.plugin !== undefined) return options.plugin
  const { version, name } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  const packed = await run('npm', ['pack', `${name}@${version}`, '--silent'], { cwd: into, timeoutMs: 180_000 })
  const file = packed.stdout.trim().split('\n').pop()
  if (packed.code !== 0 || !file?.endsWith('.tgz')) {
    throw new Error(`could not fetch the published ${name}@${version}: ${packed.stderr.slice(-500)}`)
  }
  return join(into, file)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  requiredEnvironment('DEEPSEEK_API_KEY')

  const workspace = await mkdtemp(join(tmpdir(), 'dsh-computer-real-'))
  const report = { schemaVersion: 1, lane: 'real-model-real-app', target: options.bundle, ok: false }
  let home
  try {
    const plugin = await resolvePlugin(options, workspace)
    report.plugin = plugin
    home = await prepareHome(plugin)
    const { app, observation } = await resolveTarget(options.bundle, options.name)
    report.app = app
    report.before = {
      stateHash: observation.stateHash,
      frontmost: observation.frontmost,
      windowId: observation.window.id,
      windowTitle: observation.window.title,
    }
    if (observation.window.id === undefined) {
      // Not fatal, but it is exactly the defect that hid the cursor for Notes,
      // so it is recorded rather than discovered again later.
      report.warning = 'the target exposed no window id, so the agent cursor cannot be bound to it'
    }

    const patch = join(workspace, 'real-app.patch.yml')
    await writeFile(patch, [
      '- id: computer-use',
      '  config:',
      '    settleMs: 50',
      '    maxSettleMs: 3000',
      '    grants:',
      `      - bundleId: ${options.bundle}`,
      '        read: true',
      '        control: true',
      '- id: session-title-llm',
      '  disabled: true',
      '',
    ].join('\n'))

    const sequence = options.targets.map((target, position) => `(${position + 1}) ${target}`).join(', then ')
    const prompt = `/computer-use\n\nUse the dsh-computer-use capability to operate the already running application`
      + ` "${options.name}" (bundle id ${options.bundle}). Load the Skill, list running applications, select that`
      + ` exact process, and observe it with a required screenshot and the full Accessibility state.`
      + (options.window === undefined ? '' : ` Every observation must show the window titled "${options.window}";`
        + ' if it shows any other window, stop immediately and report that instead of acting, because acting would'
        + " operate on someone's unrelated work.")
      + ` Then click these`
      + ` elements in order: ${sequence}. Take a fresh observation before each click and use that observation's id and`
      + ` element index for it, so every click is aimed at current state. After the last click, report what changed.`
      + ` Use only the focused computer-use Tools for UI observation and input; do not use shell, AppleScript, JXA,`
      + ` direct file edits, or coordinate guessing. Do not type text, delete anything, or open any other application.`
      + ` Finish immediately after reporting the change.`

    // As late as possible: an application can refocus a different window while
    // the plugin is being installed, and the check is worth nothing if it runs
    // a minute before the model looks.
    if (options.window !== undefined) {
      await focusWindow(options.bundle, options.window)
      const focused = await observe(app)
      if (focused.window.title !== options.window) {
        throw new Error(`refusing to act: expected the window "${options.window}" to be focused,`
          + ` but ${options.name} is showing "${focused.window.title ?? '(untitled)'}"`)
      }
      report.before.windowTitle = focused.window.title
      report.before.stateHash = focused.stateHash
    }

    const session = run('dsh', ['--profile', 'headless', '--patch', patch, prompt], {
      cwd: workspace,
      env: {
        DSH_HOME: home,
        DSH_TELEMETRY_DISABLED: '1',
        DSH_PERMISSION_MODE: 'workspace-write',
        DEEPSEEK_API_KEY: requiredEnvironment('DEEPSEEK_API_KEY'),
        DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com/v1',
      },
      timeoutMs: 600_000,
    })
    const samples = await sampleThroughout(session)
    const outcome = await session
    report.session = { code: outcome.code, transcript: outcome.stdout.slice(-4000), stderr: outcome.stderr.slice(-2000) }

    const after = await observe(app)
    report.after = { stateHash: after.stateHash, frontmost: after.frontmost }
    report.measured = summarise(samples, app.pid, samples.ourPids)
    report.screenshots = (await screenshots(workspace)).length

    const failures = []
    if (outcome.code !== 0) failures.push(`the session exited ${outcome.code}`)
    if (report.measured.targetEverFrontmost) {
      failures.push('the target was activated, stealing the user\'s foreground'
        + ` (${report.measured.humanPointerEvents} pointer events came from the hardware during this run, so judge`
        + ' whether a person raised it before blaming the plugin)')
    }
    if (report.measured.ourGlobalPointerEvents > 0) {
      failures.push(`${report.measured.ourGlobalPointerEvents} pointer event(s) on the system stream came from this`
        + " project, which is how the user's own cursor gets moved")
    }
    if (report.measured.agentCursorPositions.length < 2) {
      failures.push(`the agent cursor was seen at ${report.measured.agentCursorPositions.length} position(s);`
        + ' a cursor that never moves is the defect this lane exists to catch')
    }
    if (report.screenshots === 0) failures.push('computer_observe produced no screenshot Artifact')
    if (after.stateHash === observation.stateHash) failures.push('the application state never changed')

    report.failures = failures
    report.ok = failures.length === 0
  } catch (error) {
    report.failures = [error.message]
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
    if (home !== undefined) await rm(home, { recursive: true, force: true }).catch(() => undefined)
  }

  const text = `${JSON.stringify(report, null, 2)}\n`
  if (options.output !== undefined) await writeFile(options.output, text)
  process.stdout.write(text)
  process.exitCode = report.ok ? 0 : 1
}

await main()
