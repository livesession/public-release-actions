// restore-versions end to end: a git repo, pnpm and npm shims, and a registry
// holding date-based versions next to the semver line.
import assert from "node:assert/strict"
import { test } from "node:test"
import { PACKAGE, REGISTRY, why, workspace } from "./helpers.mjs"

const DATE_BASED = "^\\d{6}\\."
const restore = (box, env = {}) =>
  box.node("restore-versions.mjs", { REGISTRY, PLACEHOLDER: "0.0.0-dev", SEEDS: "{}", ...env })

test("without ignore-versions the date-based version wins (and the restore warns)", (t) => {
  const box = workspace(t)
  const r = restore(box)
  assert.equal(r.status, 0, why(r))
  assert.match(r.stdout, /@example\/ui: 202602\.1\.8 \(tags: -, registry: 202602\.1\.8\)/)
  assert.match(r.stderr, /restored the date-based version 202602\.1\.8.*ignore-versions/)
  assert.equal(box.pkgJson().version, "202602.1.8")
  assert.equal(box.restoreManifest()[PACKAGE].restored, "202602.1.8")
})

test("with ignore-versions '^\\d{6}\\.' the semver line is restored", (t) => {
  const box = workspace(t)
  const r = restore(box, { IGNORE_VERSIONS: DATE_BASED })
  assert.equal(r.status, 0, why(r))
  assert.match(r.stdout, /ignoring versions matching \/\^\\d\{6\}\\.\/ \(ignore-versions\)/)
  assert.match(r.stdout, /@example\/ui: 0\.1\.7 \(tags: -, registry: 0\.1\.7\)/)
  assert.doesNotMatch(r.stderr, /date-based version/)
  assert.equal(box.pkgJson().version, "0.1.7")
  assert.deepEqual(box.restoreManifest(), {
    [PACKAGE]: { path: "packages/ui/package.json", dir: "packages/ui", restored: "0.1.7" },
  })
})

test("release tags are filtered too", (t) => {
  const tags = [`${PACKAGE}@0.1.6`, `${PACKAGE}@202602.2.0`]
  const unfiltered = restore(workspace(t, { tags }))
  assert.match(unfiltered.stdout, /@example\/ui: 202602\.2\.0 \(tags: 202602\.2\.0, registry: 202602\.1\.8\)/)
  const filtered = restore(workspace(t, { tags }), { IGNORE_VERSIONS: DATE_BASED })
  assert.match(filtered.stdout, /@example\/ui: 0\.1\.7 \(tags: 0\.1\.6, registry: 0\.1\.7\)/)
})

test("the registry is read with the publish registry URL", (t) => {
  const box = workspace(t)
  restore(box, { IGNORE_VERSIONS: DATE_BASED })
  const views = box.calls().filter((c) => c[0] === "npm")
  assert.deepEqual(views, [["npm", "view", PACKAGE, "versions", "--json", "--registry", REGISTRY]])
})

test("only date-based versions and no seed: the loud no-version-source error names the auth to check", (t) => {
  const box = workspace(t, { versions: ["202602.0.0", "202602.1.8"] })
  const r = restore(box, { IGNORE_VERSIONS: DATE_BASED })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no version source for @example\/ui/)
  assert.match(r.stderr, /GitHub Packages: the calling job needs "packages: read"/)
  assert.match(r.stderr, /registry-token or install-token/)
  assert.equal(box.pkgJson().version, "0.0.0-dev", "nothing was written")
})

test("an invalid ignore-versions regex fails before anything is restored", (t) => {
  const box = workspace(t)
  const r = restore(box, { IGNORE_VERSIONS: "(" })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /not a valid regular expression/)
  assert.equal(box.pkgJson().version, "0.0.0-dev")
})
