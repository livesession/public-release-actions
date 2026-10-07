// Test helpers: a throwaway sandbox (HOME, work dir, a bin dir first on PATH)
// with recording shims for pnpm / npm, and a runner for the scripts.
// No dependencies beyond node itself.
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..")
export const REPO = join(SCRIPTS, "..")
export const FIXTURES = join(SCRIPTS, "test", "fixtures")
export const fixture = (...path) => readFileSync(join(FIXTURES, ...path), "utf8")
export const repoFile = (...path) => readFileSync(join(REPO, ...path), "utf8")

// the recording shim: logs [name, ...args] as one JSON line, then answers with
// the first rule whose args are a prefix of the call's
const SHIM = `
const fs = require("node:fs")
const [name, rulesPath] = [process.env.SHIM_NAME, process.env.SHIM_RULES]
const args = process.argv.slice(2)
fs.appendFileSync(process.env.SHIM_LOG, JSON.stringify([name, ...args]) + "\\n")
const rules = fs.existsSync(rulesPath) ? JSON.parse(fs.readFileSync(rulesPath, "utf8")) : []
const rule = rules.find((r) => r.args.every((a, i) => args[i] === a))
if (rule) {
  if (rule.stdout) process.stdout.write(rule.stdout)
  if (rule.stderr) process.stderr.write(rule.stderr)
  process.exit(rule.exit ?? 0)
}
`

/**
 * A sandbox directory. `shim(name, rules)` puts a recording `name` on PATH;
 * `calls()` returns every shimmed call, in order, as [name, ...args].
 */
export const sandbox = (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "public-release-actions-test-")))
  const home = join(root, "home")
  const bin = join(root, "bin")
  const cwd = join(root, "work")
  for (const dir of [home, bin, cwd]) mkdirSync(dir)
  const log = join(root, "calls.jsonl")
  writeFileSync(join(root, "shim.cjs"), SHIM)
  t?.after(() => rmSync(root, { recursive: true, force: true }))

  const box = {
    root,
    home,
    bin,
    cwd,
    githubEnv: join(root, "github_env"),
    githubOutput: join(root, "github_output"),
    shim(name, rules = []) {
      writeFileSync(join(root, `${name}.rules.json`), JSON.stringify(rules))
      const path = join(bin, name)
      writeFileSync(
        path,
        `#!/bin/sh\nSHIM_NAME='${name}' SHIM_RULES='${join(root, `${name}.rules.json`)}' exec '${process.execPath}' '${join(root, "shim.cjs")}' "$@"\n`,
      )
      chmodSync(path, 0o755)
      return box
    },
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
    resetCalls: () => rmSync(log, { force: true }),
    read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : ""),
    /** A clean environment: none of the runner's GITHUB_* / RUNNER_* / npm_config_* leak in. */
    env(extra = {}) {
      const env = {}
      for (const key of ["LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT"]) if (process.env[key]) env[key] = process.env[key]
      return {
        ...env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: home,
        SHIM_LOG: log,
        GIT_CONFIG_NOSYSTEM: "1",
        ...extra,
      }
    },
    /** Runs scripts/<script> with node in the sandbox work dir. */
    node(script, extra = {}, opts = {}) {
      return spawnSync(process.execPath, [join(SCRIPTS, script)], {
        cwd: opts.cwd ?? cwd,
        env: box.env(extra),
        encoding: "utf8",
      })
    },
    /** Runs a shell file with the flags GitHub gives a `run:` step (bash -e -o pipefail). */
    bash(file, extra = {}) {
      return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", file], {
        cwd,
        env: box.env(extra),
        encoding: "utf8",
      })
    },
    git(...args) {
      const r = spawnSync("git", ["-c", "user.name=tests", "-c", "user.email=ci@example.com", ...args], {
        cwd,
        env: box.env(),
        encoding: "utf8",
      })
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
      return r.stdout.trim()
    },
  }
  return box
}

/**
 * A git repo with one publishable package at the placeholder version, a pnpm
 * that lists it, and an npm whose registry holds `versions` for it: by default
 * a registry where another tool published date-based versions next to the
 * package's own semver line.
 */
export const PACKAGE = "@example/ui"
export const REGISTRY = "https://registry.example.com/"
export const REGISTRY_VERSIONS = ["0.1.0", "0.1.6", "0.1.7", "202602.0.0", "202602.1.8"]
export const workspace = (t, { versions = REGISTRY_VERSIONS, tags = [] } = {}) => {
  const box = sandbox(t)
  const pkgDir = join(box.cwd, "packages", "ui")
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(box.cwd, "package.json"), `${JSON.stringify({ name: "root", private: true }, null, 2)}\n`)
  writeFileSync(join(pkgDir, "package.json"), `${JSON.stringify({ name: PACKAGE, version: "0.0.0-dev" }, null, 2)}\n`)
  box.git("init", "-q", "-b", "master")
  box.git("add", "-A")
  box.git("commit", "-q", "-m", "init")
  for (const tag of tags) box.git("tag", tag)
  box.shim("pnpm", [
    {
      args: ["m", "ls", "--json", "--depth", "-1"],
      stdout: JSON.stringify([
        { name: "root", path: box.cwd, private: true },
        { name: PACKAGE, path: pkgDir, private: false },
      ]),
    },
  ])
  box.shim("npm", [{ args: ["view", PACKAGE, "versions", "--json"], stdout: JSON.stringify(versions) }])
  box.pkgJson = () => JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"))
  box.restoreManifest = () => JSON.parse(readFileSync(join(box.cwd, ".beachball-restore.json"), "utf8"))
  return box
}

/** A failure message that shows what the script printed. */
export const why = (r) => `exit ${r.status}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`
