// Publishes the release the manifest describes: every `name -> version` of
// .release/latest.json that the registry does not have yet. It needs no tag
// push event, so it publishes a release whose tags never started Publish Tag,
// and finishes one that half failed. Idempotent: a version already on the
// registry is skipped, so it is always safe to run again.
//
// Runs after checkout-release.mjs (the release's own commit on the default
// branch) and restore-versions.mjs. A package is published only when every
// workspace package it depends on is on the registry at the version it pins,
// so a consumer can always install what this publishes.
//
// env: REGISTRY, MANIFEST_PATH (default .release/latest.json),
//      PACKAGES   comma-separated names to publish (empty = the whole manifest),
//      DRY_RUN    "true" | "false": "true" shows the plan and publishes nothing,
//      PUBLISH_COMMAND template with {name} {version}
//        (default: pnpm --filter "{name}" publish --no-git-checks),
//      IGNORE_VERSIONS regex: registry versions it matches never block a publish
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { ROOT, STABLE, cmpSemver, ignoredVersions, maxStable, readJson, sh, writeJson } from "./lib.mjs"

const REGISTRY = process.env.REGISTRY || "https://npm.pkg.github.com"
const MANIFEST_PATH = process.env.MANIFEST_PATH || ".release/latest.json"
const COMMAND = process.env.PUBLISH_COMMAND || 'pnpm --filter "{name}" publish --no-git-checks'

const fail = (message) => {
  console.error(message)
  process.exit(1)
}

// inputs fail closed: anything but an explicit "false" is not a real publish
const DRY_RUN = { true: true, false: false, "": false }[process.env.DRY_RUN ?? ""]
if (DRY_RUN === undefined) fail(`dry-run must be "true" or "false", not "${process.env.DRY_RUN}"`)
const ONLY = (process.env.PACKAGES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
if ((process.env.PACKAGES || "").trim() && !ONLY.length) fail(`packages "${process.env.PACKAGES}" names no package`)
try {
  ignoredVersions()
} catch (err) {
  fail(err.message)
}

if (!existsSync(join(ROOT, MANIFEST_PATH))) {
  fail(`no ${MANIFEST_PATH} in ${ROOT} — no release to publish. Check the manifest-path input.`)
}
const released = readJson(MANIFEST_PATH).packages ?? {}
const restore = readJson(".beachball-restore.json")

const unknown = ONLY.filter((name) => !(name in released))
if (unknown.length) fail(`not in ${MANIFEST_PATH}: ${unknown.join(", ")}`)

/* ── the registry: a missing package or version is an answer, any other error is fatal ── */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const cache = new Map()
const registryVersions = (name, { fresh = false } = {}) => {
  if (!fresh && cache.has(name)) return cache.get(name)
  let versions
  try {
    const out = execFileSync("npm", ["view", name, "versions", "--json", "--registry", REGISTRY], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    const parsed = JSON.parse(out || "[]")
    versions = Array.isArray(parsed) ? parsed : [parsed]
  } catch (err) {
    const text = `${err.stdout ?? ""}${err.stderr ?? ""}`
    if (!/\bE404\b/.test(text)) {
      fail(
        `cannot read ${name} from ${REGISTRY}:\n${text.trim()}\n` +
          'Check the registry auth (GitHub Packages: the job needs "packages: read"; another registry: ' +
          "a registry-token or install-token secret that can read it).",
      )
    }
    versions = [] // never published
  }
  cache.set(name, versions)
  return versions
}
const onRegistry = (name, version, opts) => registryVersions(name, opts).includes(version)

// Every package of the release takes the manifest's version before anything is
// published, the ones not selected too, so the package manager rewrites the
// internal workspace ranges against the release.
for (const [name, version] of Object.entries(released)) {
  const info = restore[name]
  if (!info) fail(`${name} is in ${MANIFEST_PATH} but is not a publishable workspace package`)
  if (!STABLE.test(version)) fail(`${name}: "${version}" in ${MANIFEST_PATH} is not a stable x.y.z version`)
  // tags and the registry already hold a newer release: this manifest is not the
  // latest one, and publishing it would move the registry's `latest` backwards
  if (cmpSemver(version, info.restored) < 0) {
    fail(
      `${name}: ${MANIFEST_PATH} says ${version}, but ${info.restored} is already released (tags/registry). ` +
        "This is not the latest release — refusing to publish an older version.",
    )
  }
  const pkg = readJson(info.path)
  pkg.version = version
  writeJson(info.path, pkg)
}

// the workspace packages `name` needs at install time, at the versions on disk
// (which the package manager writes into the published ranges)
const workspaceDeps = (name) => {
  const pkg = readJson(restore[name].path)
  const deps = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies }
  return Object.keys(deps)
    .filter((dep) => dep !== name && dep in restore)
    .map((dep) => ({ name: dep, version: readJson(restore[dep].path).version }))
}

const selected = Object.keys(released).filter((name) => !ONLY.length || ONLY.includes(name))

// Dependencies first. A cycle keeps manifest order.
const ordered = []
const state = new Map() // name -> "visiting" | "done"
const visit = (name) => {
  if (state.get(name)) return
  state.set(name, "visiting")
  for (const dep of workspaceDeps(name)) if (selected.includes(dep.name)) visit(dep.name)
  state.set(name, "done")
  ordered.push(name)
}
selected.forEach(visit)

const PUBLISHED = "published"
const ALREADY = "already published"
const WOULD = "would publish (dry run)"
const outcome = new Map() // name -> result, this run
const available = (dep) => {
  const result = outcome.get(dep.name)
  if (result === PUBLISHED || result?.startsWith(ALREADY)) return released[dep.name] === dep.version
  if (result === WOULD) return released[dep.name] === dep.version
  return onRegistry(dep.name, dep.version)
}

const results = []
const record = (name, version, result) => {
  outcome.set(name, result)
  results.push({ name, version, result })
}
for (const name of ordered) {
  const version = released[name]
  if (onRegistry(name, version)) {
    console.log(`skip ${name}@${version} (already on the registry)`)
    record(name, version, ALREADY)
    continue
  }
  const newer = maxStable(registryVersions(name))
  if (newer && cmpSemver(newer, version) > 0) {
    record(name, version, `BLOCKED: ${newer} is already on the registry; publishing ${version} would move latest back`)
    continue
  }
  const missing = workspaceDeps(name).filter((dep) => !available(dep))
  if (missing.length) {
    const needs = missing.map((dep) => `${dep.name}@${dep.version}`).join(", ")
    console.error(`${name}@${version} needs ${needs}, which is not on the registry`)
    record(name, version, `BLOCKED: needs ${needs} on the registry first`)
    continue
  }
  if (DRY_RUN) {
    console.log(`would publish ${name}@${version}`)
    record(name, version, WOULD)
    continue
  }
  console.log(`publishing ${name}@${version}`)
  let exited = true
  try {
    sh(COMMAND.replaceAll("{name}", name).replaceAll("{version}", version), { stdio: "inherit" })
  } catch {
    exited = false
  }
  // an exit code is not proof: pnpm exits 0 when it decides there is nothing to
  // publish, and a failed publish may be one another run won. Ask the registry.
  let landed = false
  for (let attempt = 0; attempt < 5 && !landed; attempt++) {
    if (attempt) sleep(3000)
    landed = onRegistry(name, version, { fresh: true })
  }
  if (landed) record(name, version, exited ? PUBLISHED : `${ALREADY} (by another run)`)
  else {
    console.error(`FAILED ${name}@${version}`)
    record(name, version, exited ? "FAILED: the command exited 0 but the version is not on the registry" : "FAILED")
  }
}

const table = [
  `### ${DRY_RUN ? "Dry run: " : ""}release from ${MANIFEST_PATH}`,
  "",
  "| package | version | result |",
  "|---|---|---|",
  ...results.map((r) => `| \`${r.name}\` | ${r.version} | ${r.result} |`),
  "",
].join("\n")
console.log(`\n${table}`)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table)

const bad = results.filter((r) => /^(FAILED|BLOCKED)/.test(r.result))
if (bad.length) fail(`${bad.length} package(s) not published: ${bad.map((r) => r.name).join(", ")}`)
