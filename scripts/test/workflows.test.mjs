// Structural checks on the reusable workflows and composites that the unit
// tests cannot see: the workflow_call contract, wiring and step order.
import assert from "node:assert/strict"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, test } from "node:test"
import { REPO, repoFile } from "./helpers.mjs"

const WORKFLOWS = readdirSync(join(REPO, ".github", "workflows")).filter((f) => f.endsWith(".yml"))
const reusable = WORKFLOWS.filter((f) => /^\s+workflow_call:/m.test(repoFile(".github", "workflows", f)))
const workflow = (name) => repoFile(".github", "workflows", `${name}.yml`)
const PUBLISHING = ["canary", "release-pr", "publish-tag", "publish-latest"]
const ACTIONS = [
  "checkout-release",
  "create-tags",
  "prepare-release-pr",
  "publish-canary",
  "publish-manifest",
  "publish-tag",
  "registry-auth",
  "resolve-config",
  "restore-versions",
]

/** The names declared under `inputs:` / `secrets:` of a workflow_call block (6-space keys). */
const declared = (text, section) => {
  const start = text.indexOf(`\n    ${section}:\n`)
  if (start === -1) return []
  const rest = text.slice(start + section.length + 7)
  const end = rest.search(/^ {0,4}\S/m) // the next 4-space (or shallower) key ends the section
  return [...(end === -1 ? rest : rest.slice(0, end)).matchAll(/^ {6}([\w-]+):$/gm)].map((m) => m[1])
}

describe("the workflow_call contract", () => {
  const COMMON = ["registry", "node-version", "pnpm-version"]
  const PM = ["package-manager", "bun-version"]
  const RELEASE = ["placeholder-version", "tag-template", "seeds"]
  const expected = {
    check: { inputs: ["node-version"], secrets: [] },
    canary: {
      inputs: [...COMMON, ...PM, "build-command", "canary-preid", "canary-publish-command", "github-registry"],
      secrets: ["registry-token", "install-token"],
    },
    "release-pr": {
      inputs: [...COMMON, ...PM, "scope", "release-branch", ...RELEASE, "manifest-path", "github-registry", "ignore-versions"],
      secrets: ["registry-token", "install-token"],
    },
    "tag-release": { inputs: ["manifest-path", "tag-template"], secrets: ["tag-token"] },
    "publish-tag": {
      inputs: [...COMMON, "build-command", ...RELEASE, "publish-command", "github-registry", "ignore-versions"],
      secrets: ["registry-token", "install-token"],
    },
    "publish-latest": {
      inputs: [...COMMON, "build-command", ...RELEASE, "publish-command", "manifest-path", "packages", "dry-run", "github-registry", "ignore-versions"],
      secrets: ["registry-token", "install-token"],
    },
  }

  test("the six reusable workflows, and only them", () => {
    assert.deepEqual(reusable.sort(), Object.keys(expected).map((n) => `${n}.yml`).sort())
  })

  for (const [name, { inputs, secrets }] of Object.entries(expected)) {
    test(`${name} declares exactly its documented inputs and secrets`, () => {
      const text = workflow(name)
      assert.deepEqual(declared(text, "inputs"), inputs)
      assert.deepEqual(declared(text, "secrets"), secrets)
    })
  }

  test("every input has a type, and every secret is optional", () => {
    for (const file of reusable) {
      const text = repoFile(".github", "workflows", file)
      for (const input of declared(text, "inputs")) assert.match(text, new RegExp(`^ {6}${input}:\\n {8}type: (string|boolean)\\n`, "m"), `${file}: ${input}`)
      for (const secret of declared(text, "secrets")) assert.match(text, new RegExp(`^ {6}${secret}:\\n {8}required: false\\n`, "m"), `${file}: ${secret}`)
    }
  })

  test("reusable workflows declare no permissions (a called workflow can't exceed its caller's)", () => {
    for (const file of reusable) {
      assert.doesNotMatch(repoFile(".github", "workflows", file), /^\s*permissions:/m, file)
    }
  })
})

test("this repository's actions: one ref for all of them, and every action exists", () => {
  const refs = new Set()
  let found = 0
  for (const file of WORKFLOWS) {
    for (const [, action, ref] of repoFile(".github", "workflows", file).matchAll(
      /uses: livesession\/public-release-actions\/actions\/([\w-]+)@(\S+)/g,
    )) {
      found++
      refs.add(ref)
      assert.ok(ACTIONS.includes(action), `${file}: actions/${action} is not one of this repository's actions`)
      assert.ok(existsSync(join(REPO, "actions", action, "action.yml")), `${file}: actions/${action} does not exist`)
    }
  }
  assert.ok(found > 0, "the workflows use the composites")
  assert.deepEqual([...refs], ["v1"], `mixed refs: ${[...refs].join(", ")}`)
})

test("no workflow writes registry credentials in shell (the registry-auth composite does)", () => {
  for (const file of WORKFLOWS) {
    const text = repoFile(".github", "workflows", file)
    assert.doesNotMatch(text, /REGISTRY#https:/, file)
    assert.doesNotMatch(text, /pnpm config set/, file)
    assert.doesNotMatch(text, /_authToken/, file)
  }
})

describe("registry auth wiring", () => {
  for (const name of PUBLISHING) {
    test(`${name}: github-registry defaults to GitHub Packages`, () => {
      assert.match(workflow(name), /^ {6}github-registry:\n {8}type: string\n {8}default: "https:\/\/npm\.pkg\.github\.com"/m)
    })

    test(`${name}: registry-auth (install) -> install${name === "release-pr" ? "" : " -> registry-auth (publish)"}`, () => {
      const text = workflow(name)
      const installAuth = text.indexOf("actions/registry-auth@")
      const install = text.search(/run: .*install --frozen-lockfile/)
      assert.ok(installAuth > 0 && install > installAuth, "the install credential is written before the install")
      const installStep = text.slice(installAuth, install)
      assert.match(installStep, /mode: install\n/)
      assert.match(installStep, /github-registry: \$\{\{ inputs\.github-registry \}\}/)
      assert.match(installStep, /token: \$\{\{ env\.GITHUB_NPM_TOKEN \}\}/)
      const publishAuth = text.indexOf("actions/registry-auth@", install)
      if (name === "release-pr") {
        assert.equal(publishAuth, -1, "release-pr only installs")
        assert.doesNotMatch(text, /PUBLISH_TOKEN/)
      } else {
        assert.ok(publishAuth > install, "the publish credential is written after the install")
        assert.match(text.slice(publishAuth), /^[^\n]*\n\s+with:\n\s+mode: publish\n/)
        assert.match(text.slice(publishAuth), /token: \$\{\{ env\.PUBLISH_TOKEN \}\}/)
        assert.match(text, /PUBLISH_TOKEN: \$\{\{ secrets\.registry-token \|\| github\.token \}\}/)
      }
      assert.match(text, /GITHUB_NPM_TOKEN: \$\{\{ secrets\.install-token \|\| secrets\.registry-token \|\| github\.token \}\}/)
    })
  }

  test("publish-latest writes the install credential after checking out the release", () => {
    const text = workflow("publish-latest")
    assert.ok(text.indexOf("actions/registry-auth@") > text.indexOf("actions/checkout-release@"))
  })

  test("tag-release pushes with tag-token, else the workflow token", () => {
    assert.match(workflow("tag-release"), /token: \$\{\{ secrets\.tag-token \|\| github\.token \}\}/)
  })
})

describe("ignore-versions plumbing", () => {
  const passes = {
    "release-pr": ["prepare-release-pr"],
    "publish-tag": ["restore-versions"],
    "publish-latest": ["restore-versions", "publish-manifest"],
  }
  for (const [name, actions] of Object.entries(passes)) {
    for (const action of actions) {
      test(`${name} passes ignore-versions to ${action}`, () => {
        const text = workflow(name)
        const step = text.slice(text.indexOf(`actions/${action}@`))
        const next = step.search(/\n {6}- /) // the next step, if any
        const withBlock = next === -1 ? step : step.slice(0, next)
        assert.match(withBlock, /ignore-versions: \$\{\{ inputs\.ignore-versions \}\}/)
      })
    }
  }
  for (const action of ["restore-versions", "prepare-release-pr", "publish-manifest"]) {
    test(`actions/${action} maps ignore-versions to IGNORE_VERSIONS`, () => {
      const text = repoFile("actions", action, "action.yml")
      assert.match(text, /^ {2}ignore-versions:\n {4}default: ""/m)
      assert.ok(text.includes("IGNORE_VERSIONS: ${{ inputs.ignore-versions }}"))
    })
  }
})

describe("composites", () => {
  test("exactly the documented set, each a composite with a description", () => {
    assert.deepEqual(readdirSync(join(REPO, "actions")).sort(), ACTIONS)
    for (const action of ACTIONS) {
      const text = repoFile("actions", action, "action.yml")
      assert.match(text, new RegExp(`^name: ${action}\\n`), `actions/${action}`)
      assert.match(text, /^description: /m, `actions/${action}`)
      assert.match(text, /^runs:\n {2}using: composite\n {2}steps:\n/m, `actions/${action}`)
    }
  })

  test("they find their scripts through $GITHUB_ACTION_PATH, which also works in container jobs", () => {
    // ${{ github.action_path }} expands to the runner's host path (/home/runner/work/_actions/...),
    // which does not exist inside a job's container (mounted at /__w/_actions/...).
    // The GITHUB_ACTION_PATH environment variable is set to the right path in both cases.
    for (const action of ACTIONS) {
      const text = repoFile("actions", action, "action.yml")
      assert.doesNotMatch(text, /github\.action_path/, `actions/${action}`)
      const scripts = [...text.matchAll(/node "([^"]+\.mjs)"/g)].map((m) => m[1])
      assert.ok(scripts.length > 0, `actions/${action} runs a script`)
      for (const script of scripts) {
        const m = /^\$GITHUB_ACTION_PATH\/\.\.\/\.\.\/scripts\/([\w-]+\.mjs)$/.exec(script)
        assert.ok(m, `actions/${action}: ${script}`)
        assert.ok(existsSync(join(REPO, "scripts", m[1])), `actions/${action}: scripts/${m[1]} does not exist`)
      }
    }
  })
})
