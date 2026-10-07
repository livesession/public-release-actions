// Prepares the Release PR content on the current branch:
//   1. restores real versions (restore-versions.mjs)
//   2. `beachball bump` — applies change files: bumps versions on disk,
//      generates CHANGELOGs, deletes consumed change files (no git/npm ops)
//   3. captures the computed next versions into the release manifest
//   4. restores the placeholder versions + lockfile
// The calling workflow commits: CHANGELOGs + change-file deletions + manifest.
//
// env: RELEASE_SCOPE (comma-separated package names; empty = everything),
//      PLACEHOLDER, MANIFEST_PATH, plus restore-versions' env
import { dirname, join } from "node:path"
import { appendFileSync, mkdirSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { ROOT, loadBeachballConfig, readJson, sh, writeJson } from "./lib.mjs"

const SCRIPTS = dirname(fileURLToPath(import.meta.url))
const PLACEHOLDER = process.env.PLACEHOLDER || "0.0.0-dev"
const MANIFEST_PATH = process.env.MANIFEST_PATH || ".release/latest.json"

sh(`node "${join(SCRIPTS, "restore-versions.mjs")}"`, { stdio: "inherit" })
const restored = readJson(".beachball-restore.json")

// RELEASE_SCOPE: partial release — only scoped packages' change files are
// consumed; the rest stay pending for the next Release PR. Lockstep group
// members are auto-expanded.
const scopeNames = (process.env.RELEASE_SCOPE || "").split(",").map((s) => s.trim()).filter(Boolean)

let bumpCmd = "pnpm exec beachball bump"
if (scopeNames.length > 0) {
  const { groups = [] } = await loadBeachballConfig()
  const dirs = new Set()
  for (const name of scopeNames) {
    const info = restored[name]
    if (!info) {
      console.error(`unknown package in RELEASE_SCOPE: ${name}`)
      process.exit(1)
    }
    dirs.add(info.dir)
  }
  for (const group of groups) {
    if ((group.include ?? []).some((dir) => dirs.has(dir))) {
      for (const dir of group.include) {
        if (!dirs.has(dir)) {
          console.log(`scope expanded with ${dir} (lockstep group "${group.name}")`)
          dirs.add(dir)
        }
      }
    }
  }
  bumpCmd += [...dirs].map((d) => ` --scope "${d}"`).join("")
  console.log(`partial release scope: ${[...dirs].join(", ")}`)
}
sh(bumpCmd, { stdio: "inherit" })

const releases = {}
for (const [name, info] of Object.entries(restored)) {
  const current = readJson(info.path).version
  if (current !== info.restored && current !== PLACEHOLDER) releases[name] = current
}

// restore committed placeholders; keep changelogs + change-file deletions
sh(`git checkout -- ${Object.values(restored).map((i) => `"${i.path}"`).join(" ")}`)
for (const lockfile of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
  try {
    sh(`git checkout -- ${lockfile} 2>/dev/null`)
  } catch {
    /* untouched or absent */
  }
}
rmSync(join(ROOT, ".beachball-restore.json"))

if (Object.keys(releases).length === 0) {
  console.log("no releases computed — nothing to prepare")
  process.exit(0)
}

mkdirSync(join(ROOT, dirname(MANIFEST_PATH)), { recursive: true })
writeJson(MANIFEST_PATH, { packages: releases })

const summary = Object.entries(releases).map(([n, v]) => `${n}@${v}`).join("\n")
console.log(`release manifest written to ${MANIFEST_PATH}:`)
console.log(summary)
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `summary<<EOF\n${summary}\nEOF\n`)
}
