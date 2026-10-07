// registry-auth: the golden test (with the default inputs the script makes
// exactly the calls of the plain shell steps in fixtures/steps) and the
// behaviour around it.
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, test } from "node:test"
import { FIXTURES, fixture, repoFile, sandbox, why } from "./helpers.mjs"

const GITHUB = "https://npm.pkg.github.com"

// scripts/test/fixtures/steps/<workflow>.<mode>.sh: the credential write of each
// workflow's registry-auth step, as a plain shell step
const STEPS = [
  { file: "canary.install.sh", mode: "install", tokenEnv: "GITHUB_NPM_TOKEN", pmAware: true },
  { file: "canary.publish.sh", mode: "publish", tokenEnv: "PUBLISH_TOKEN", pmAware: true },
  { file: "release-pr.install.sh", mode: "install", tokenEnv: "GITHUB_NPM_TOKEN", pmAware: true },
  { file: "publish-tag.install.sh", mode: "install", tokenEnv: "GITHUB_NPM_TOKEN", pmAware: false },
  { file: "publish-tag.publish.sh", mode: "publish", tokenEnv: "PUBLISH_TOKEN", pmAware: false },
  { file: "publish-latest.install.sh", mode: "install", tokenEnv: "GITHUB_NPM_TOKEN", pmAware: false },
  { file: "publish-latest.publish.sh", mode: "publish", tokenEnv: "PUBLISH_TOKEN", pmAware: false },
]

/** The env the composite gives the script: action.yml maps each input to one variable. */
const inputs = ({ mode, registry = GITHUB, githubRegistry = GITHUB, packageManager = "pnpm", token }) => ({
  MODE: mode,
  REGISTRY: registry,
  GH_REGISTRY: githubRegistry,
  PACKAGE_MANAGER: packageManager,
  REGISTRY_AUTH_TOKEN: token,
})

const runShell = (t, step, { registry, pm, token }) => {
  const box = sandbox(t).shim("pnpm")
  const env = { REGISTRY: registry, [step.tokenEnv]: token }
  if (step.pmAware) env.PM = pm
  const r = box.bash(join(FIXTURES, "steps", step.file), env)
  assert.equal(r.status, 0, why(r))
  return { calls: box.calls(), npmrc: box.read(join(box.home, ".npmrc")) }
}

const runScript = (t, args) => {
  const box = sandbox(t).shim("pnpm")
  const r = box.node("registry-auth.mjs", inputs(args))
  assert.equal(r.status, 0, why(r))
  return { calls: box.calls(), npmrc: box.read(join(box.home, ".npmrc")), stdout: r.stdout, stderr: r.stderr }
}

describe("golden: default inputs write exactly what the plain shell steps write", () => {
  for (const step of STEPS) {
    for (const registry of [GITHUB, `${GITHUB}/`]) {
      test(`${step.file} (registry ${registry}, pnpm)`, (t) => {
        const token = `tok-${step.mode}-123`
        const shell = runShell(t, step, { registry, pm: "pnpm", token })
        const script = runScript(t, { mode: step.mode, registry, token })
        assert.deepEqual(shell.calls, [["pnpm", "config", "set", "//npm.pkg.github.com/:_authToken", token]])
        assert.deepEqual(script.calls, shell.calls)
        assert.equal(script.npmrc, shell.npmrc)
        assert.equal(script.npmrc, "")
      })
    }
  }
})

describe("bun: a line in ~/.npmrc, with the slash before the colon", () => {
  for (const step of STEPS.filter((s) => s.pmAware)) {
    test(step.file, (t) => {
      const shell = runShell(t, step, { registry: GITHUB, pm: "bun", token: "T" })
      const script = runScript(t, { mode: step.mode, registry: GITHUB, packageManager: "bun", token: "T" })
      // "//npm.pkg.github.com:_authToken" (no "/") would match no registry
      assert.equal(script.npmrc, "//npm.pkg.github.com/:_authToken=T\n")
      assert.equal(script.npmrc, shell.npmrc)
      assert.deepEqual(script.calls, [], "bun mode never calls pnpm")
    })
  }

  test("a later write appends, and the later line wins", (t) => {
    const box = sandbox(t).shim("pnpm")
    for (const [mode, token] of [
      ["install", "READ"],
      ["publish", "WRITE"],
    ]) {
      const r = box.node("registry-auth.mjs", inputs({ mode, packageManager: "bun", token }))
      assert.equal(r.status, 0, why(r))
    }
    assert.equal(
      box.read(join(box.home, ".npmrc")),
      "//npm.pkg.github.com/:_authToken=READ\n//npm.pkg.github.com/:_authToken=WRITE\n",
    )
  })
})

describe("other registries", () => {
  test("install with another registry: github-registry first, then the registry", (t) => {
    const now = runScript(t, { mode: "install", registry: "https://registry.npmjs.org/", token: "T" })
    assert.deepEqual(now.calls, [
      ["pnpm", "config", "set", "//npm.pkg.github.com/:_authToken", "T"],
      ["pnpm", "config", "set", "//registry.npmjs.org/:_authToken", "T"],
    ])
  })

  test("install with another registry and github-registry \"\": the registry alone", (t) => {
    const now = runScript(t, { mode: "install", registry: "https://registry.npmjs.org/", githubRegistry: "", token: "T" })
    assert.deepEqual(now.calls, [["pnpm", "config", "set", "//registry.npmjs.org/:_authToken", "T"]])
  })

  test("publish to another registry: only the registry", (t) => {
    const now = runScript(t, { mode: "publish", registry: "https://registry.npmjs.org/", token: "T" })
    assert.deepEqual(now.calls, [["pnpm", "config", "set", "//registry.npmjs.org/:_authToken", "T"]])
  })

  test("publish to another registry with bun: one ~/.npmrc line for the registry", (t) => {
    const now = runScript(t, { mode: "publish", registry: "https://registry.npmjs.org/", packageManager: "bun", token: "T" })
    assert.equal(now.npmrc, "//registry.npmjs.org/:_authToken=T\n")
    assert.deepEqual(now.calls, [])
  })

  test("github-registry \"\" with the default registry still writes the registry", (t) => {
    const now = runScript(t, { mode: "install", githubRegistry: "", token: "T" })
    assert.deepEqual(now.calls, [["pnpm", "config", "set", "//npm.pkg.github.com/:_authToken", "T"]])
  })

  test("a registry with and without the trailing slash is one credential key", (t) => {
    const now = runScript(t, { mode: "install", registry: `${GITHUB}/`, githubRegistry: GITHUB, token: "T" })
    assert.deepEqual(now.calls, [["pnpm", "config", "set", "//npm.pkg.github.com/:_authToken", "T"]])
  })
})

describe("guards", () => {
  test("no token: nothing written, exit 0", (t) => {
    const now = runScript(t, { mode: "install", token: "" })
    assert.deepEqual(now.calls, [])
    assert.match(now.stderr, /no token/)
  })

  test("an unknown mode fails", (t) => {
    const box = sandbox(t).shim("pnpm")
    const r = box.node("registry-auth.mjs", inputs({ mode: "both", token: "T" }))
    assert.equal(r.status, 1)
    assert.deepEqual(box.calls(), [])
  })

  test("the token is never printed", (t) => {
    const now = runScript(t, { mode: "install", registry: "https://registry.npmjs.org/", token: "SECRET-VALUE-42" })
    assert.doesNotMatch(now.stdout + now.stderr, /SECRET-VALUE-42/)
  })

  test("the project .npmrc is never touched: credentials are user-level only", (t) => {
    const box = sandbox(t).shim("pnpm")
    const npmrc = fixture("project.npmrc")
    writeFileSync(join(box.cwd, ".npmrc"), npmrc)
    for (const [mode, pm] of [
      ["install", "pnpm"],
      ["publish", "pnpm"],
      ["install", "bun"],
      ["publish", "bun"],
    ]) {
      const r = box.node("registry-auth.mjs", inputs({ mode, packageManager: pm, token: "T" }))
      assert.equal(r.status, 0, why(r))
    }
    assert.equal(box.read(join(box.cwd, ".npmrc")), npmrc, "the committed .npmrc keeps its scope lines and gains no credential")
    assert.doesNotMatch(npmrc, /_authToken/, "the fixture itself holds no credential line")
    assert.equal(box.read(join(box.home, ".npmrc")), "//npm.pkg.github.com/:_authToken=T\n".repeat(2), "bun wrote user-level")
  })
})

test("actions/registry-auth maps every input to the variable the script reads", () => {
  const action = repoFile("actions", "registry-auth", "action.yml")
  for (const line of [
    "MODE: ${{ inputs.mode }}",
    "REGISTRY: ${{ inputs.registry }}",
    "GH_REGISTRY: ${{ inputs.github-registry }}",
    "PACKAGE_MANAGER: ${{ inputs.package-manager }}",
    "REGISTRY_AUTH_TOKEN: ${{ inputs.token }}",
    'run: node "$GITHUB_ACTION_PATH/../../scripts/registry-auth.mjs"',
  ]) {
    assert.ok(action.includes(line), `action.yml is missing: ${line}`)
  }
  assert.match(action, /github-registry:\n(?:\s+description:.*\n)?\s+default: "https:\/\/npm\.pkg\.github\.com"/)
})
