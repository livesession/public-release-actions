// publish-manifest end to end (dry run): a first 1.0.0 release of a package
// whose registry holds date-based versions next to its 0.1.x semver line.
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { PACKAGE, REGISTRY, why, workspace } from "./helpers.mjs"

const DATE_BASED = "^\\d{6}\\."

/** restore-versions, then a 1.0.0 manifest, then publish-manifest; each with its own IGNORE_VERSIONS. */
const release = (t, { restoreIgnore = "", publishIgnore = "", dryRun = "true" } = {}) => {
  const box = workspace(t)
  const restored = box.node("restore-versions.mjs", { REGISTRY, IGNORE_VERSIONS: restoreIgnore })
  assert.equal(restored.status, 0, why(restored))
  mkdirSync(join(box.cwd, ".release"))
  writeFileSync(join(box.cwd, ".release", "latest.json"), JSON.stringify({ packages: { [PACKAGE]: "1.0.0" } }))
  box.resetCalls()
  const r = box.node("publish-manifest.mjs", {
    REGISTRY,
    MANIFEST_PATH: ".release/latest.json",
    DRY_RUN: dryRun,
    IGNORE_VERSIONS: publishIgnore,
  })
  return { box, r }
}

test("without ignore-versions: restore gives 202602.1.8 and the 1.0.0 release is refused", (t) => {
  const { r } = release(t)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /says 1\.0\.0, but 202602\.1\.8 is already released/)
})

test("ignore-versions on the restore only: BLOCKED by the date-based version on the registry", (t) => {
  const { r } = release(t, { restoreIgnore: DATE_BASED })
  assert.equal(r.status, 1)
  assert.match(
    r.stdout,
    /\| `@example\/ui` \| 1\.0\.0 \| BLOCKED: 202602\.1\.8 is already on the registry; publishing 1\.0\.0 would move latest back \|/,
  )
})

test("ignore-versions on both: restore gives 0.1.7 and 1.0.0 would publish", (t) => {
  const { box, r } = release(t, { restoreIgnore: DATE_BASED, publishIgnore: DATE_BASED })
  assert.equal(r.status, 0, why(r))
  assert.match(r.stdout, /would publish @example\/ui@1\.0\.0/)
  assert.match(r.stdout, /\| `@example\/ui` \| 1\.0\.0 \| would publish \(dry run\) \|/)
  assert.equal(box.pkgJson().version, "1.0.0", "the manifest version is written before publishing")
  assert.deepEqual(
    box.calls().filter((c) => c[0] === "pnpm"),
    [],
    "a dry run publishes nothing",
  )
  assert.ok(
    box.calls().every((c) => c[0] !== "npm" || c.includes(REGISTRY)),
    "every registry read goes to the publish registry",
  )
})

test("an invalid ignore-versions regex fails with a clear message", (t) => {
  const { r } = release(t, { restoreIgnore: DATE_BASED, publishIgnore: "[" })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /IGNORE_VERSIONS "\[" is not a valid regular expression/)
})
