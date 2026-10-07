// Runs on the default branch after a Release PR merges: reads the release
// manifest and creates one annotated release tag per package at HEAD.
// Idempotent — existing tags are skipped, so re-runs and pushes that don't
// change the manifest are no-ops. Pushed tags trigger the per-tag publish.
//
// env: MANIFEST_PATH (default .release/latest.json), TAG_TEMPLATE
import { existsSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_TAG_TEMPLATE, ROOT, readJson, sh, tagName } from "./lib.mjs"

const MANIFEST_PATH = process.env.MANIFEST_PATH || ".release/latest.json"
const TAG_TEMPLATE = process.env.TAG_TEMPLATE || DEFAULT_TAG_TEMPLATE

if (!existsSync(join(ROOT, MANIFEST_PATH))) {
  // Loud, not exit(0). This workflow only runs because that file changed, so
  // its absence means something upstream is wrong — a manifest-path mismatch,
  // or a checkout that missed the merge commit. Exiting green would make a
  // broken release look identical to a successful no-op: a passing run, no
  // tags, and nothing to point at.
  console.error(
    `no ${MANIFEST_PATH} in ${ROOT} — nothing to tag.\n` +
      "Tag Release is triggered by that file changing, so it should be here. " +
      "Check the manifest-path input and that the job checked out the merge commit.",
  )
  process.exit(1)
}
const { packages } = readJson(MANIFEST_PATH)

const created = []
for (const [name, version] of Object.entries(packages)) {
  const tag = tagName(TAG_TEMPLATE, name, version)
  try {
    sh(`git rev-parse -q --verify "refs/tags/${tag}" 2>/dev/null`)
    console.log(`skip ${tag} (tag exists)`)
  } catch {
    sh(`git tag -a "${tag}" -m "${name} v${version}"`)
    created.push(tag)
    console.log(`created ${tag}`)
  }
}

if (created.length === 0) {
  console.log("all tags already exist — nothing to push")
  process.exit(0)
}

// One push per tag, never one push for all of them. GitHub creates no push
// event for tags when more than three are pushed at once, so a release of four
// or more packages would push its tags and publish none: the tags appear, and
// Publish Tag never runs. A tag's own push is its own event. A re-run after a
// failed push skips the tags already on the remote.
//
// GitHub answers a push with a 5xx now and then. So each push is retried with
// a growing pause, and a tag that still fails never stops the others: the run
// fails at the end, naming what is missing, and a re-run pushes only that.
const ATTEMPTS = 4
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const failed = []
for (const tag of created) {
  let pushed = false
  for (let attempt = 1; attempt <= ATTEMPTS && !pushed; attempt++) {
    try {
      sh(`git push --no-verify origin "refs/tags/${tag}"`)
      pushed = true
    } catch {
      if (attempt < ATTEMPTS) {
        console.warn(`push of ${tag} failed (attempt ${attempt} of ${ATTEMPTS}) — retrying in ${5 * attempt}s`)
        sleep(5000 * attempt)
      }
    }
  }
  if (pushed) console.log(`pushed ${tag}`)
  else {
    console.error(`FAILED to push ${tag} after ${ATTEMPTS} attempts`)
    failed.push(tag)
  }
}
const done = created.length - failed.length
console.log(`pushed ${done} tag(s), one push each — publish workflows will pick them up`)
if (failed.length) {
  console.error(
    `${failed.length} tag(s) not pushed: ${failed.join(", ")}. ` +
      "Re-run Tag Release: it skips the tags already on the remote and pushes only these.",
  )
  process.exit(1)
}
