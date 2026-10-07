// Checks out the commit of the latest release, so publish-manifest publishes
// what was released rather than whatever the branch holds now:
//   - the commit the release's tags point at, when tag-release made them
//     (the commit Publish Tag would publish from);
//   - else the default branch's own commit that last changed the manifest
//     (`--first-parent`: the Release PR's merge, where tag-release tags).
// Only a merged release is published: the run must be on the default branch,
// and the release commit must be in its history. An open Release PR
// (release/next) carries a newer manifest, and merging it is the approval.
// Tags that disagree, tags before the manifest change, or a tagged commit
// whose manifest is not this release fail loudly.
//
// env: MANIFEST_PATH (default .release/latest.json), TAG_TEMPLATE,
//      DEFAULT_BRANCH (the repository's default branch), GITHUB_REF
// outputs (GITHUB_OUTPUT): sha, pnpm-version (from the release's packageManager)
import { appendFileSync } from "node:fs"
import { DEFAULT_TAG_TEMPLATE, sh, tagName } from "./lib.mjs"

const MANIFEST_PATH = process.env.MANIFEST_PATH || ".release/latest.json"
const TAG_TEMPLATE = process.env.TAG_TEMPLATE || DEFAULT_TAG_TEMPLATE
const DEFAULT_BRANCH = process.env.DEFAULT_BRANCH
const REF = process.env.GITHUB_REF

const fail = (message) => {
  console.error(message)
  process.exit(1)
}
const isAncestor = (a, b) => {
  try {
    sh(`git merge-base --is-ancestor "${a}" "${b}"`)
    return true
  } catch {
    return false
  }
}
const manifestAt = (commit) => {
  try {
    return JSON.parse(sh(`git show "${commit}:${MANIFEST_PATH}" 2>/dev/null`))
  } catch {
    return null
  }
}
const same = (a, b) => JSON.stringify(a?.packages ?? null) === JSON.stringify(b?.packages ?? null)

if (!DEFAULT_BRANCH) fail("DEFAULT_BRANCH is not set — cannot tell a merged release from an open one")
if (REF !== `refs/heads/${DEFAULT_BRANCH}`) {
  fail(
    `run on ${REF}, not on ${DEFAULT_BRANCH}. Only a merged release is published: ` +
      `start the workflow from ${DEFAULT_BRANCH} ("Use workflow from").`,
  )
}

const changedAt = sh(`git log -1 --first-parent --format=%H -- "${MANIFEST_PATH}"`)
if (!changedAt) fail(`no commit on ${DEFAULT_BRANCH} changed ${MANIFEST_PATH} — no release to publish`)
const manifest = manifestAt(changedAt)
if (!manifest) fail(`${MANIFEST_PATH} was deleted in ${changedAt} — no release to publish`)

const tagged = new Map() // commit -> tags
for (const [name, version] of Object.entries(manifest.packages ?? {})) {
  const tag = tagName(TAG_TEMPLATE, name, version)
  let commit = ""
  try {
    commit = sh(`git rev-list -n 1 "refs/tags/${tag}" 2>/dev/null`)
  } catch {
    /* not tagged */
  }
  if (commit) tagged.set(commit, [...(tagged.get(commit) ?? []), tag])
}

let release = changedAt
if (tagged.size > 1) {
  fail(
    "the release's tags point at different commits:\n" +
      [...tagged].map(([commit, tags]) => `  ${commit}: ${tags.join(", ")}`).join("\n"),
  )
}
if (tagged.size === 1) {
  const [commit] = tagged.keys()
  if (!same(manifestAt(commit), manifest)) {
    fail(`the release's tags point at ${commit}, whose ${MANIFEST_PATH} is not the release changed in ${changedAt}`)
  }
  if (!isAncestor(changedAt, commit)) {
    fail(`the release's tags point at ${commit}, which does not contain the manifest change ${changedAt}`)
  }
  release = commit
}
// the remote default branch itself (fetch-depth: 0 fetches it), not only the checkout
let branch = "HEAD"
try {
  sh(`git rev-parse -q --verify "refs/remotes/origin/${DEFAULT_BRANCH}"`)
  branch = `origin/${DEFAULT_BRANCH}`
} catch {
  /* no remote-tracking ref: the checkout is the default branch (checked above) */
}
if (!isAncestor(release, branch)) fail(`the release commit ${release} is not on ${DEFAULT_BRANCH}`)

// tag-release tags the head of the push that merged the release, so commits
// pushed with the merge ship in the release too: show them
const extra = release === changedAt ? "" : sh(`git log --oneline "${changedAt}..${release}"`)

sh(`git checkout --quiet --detach "${release}"`)
const how = tagged.size ? "the release's tags" : `the last change of ${MANIFEST_PATH} on ${DEFAULT_BRANCH}`
const lines = [`release commit ${release} (${how}): ${sh("git log -1 --format=%s")}`]
if (extra) lines.push(`it also carries these commits after the manifest change:\n${extra}`)
console.log(lines.join("\n"))
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n\n").replace(/\n(?=[0-9a-f]{7,} )/g, "\n- ")}\n\n`)
}

// the release's own pnpm, so a later packageManager bump on the branch cannot
// clash with the code being built
const pm = JSON.parse(sh("git show HEAD:package.json 2>/dev/null || echo '{}'")).packageManager ?? ""
const pnpm = /^pnpm@([^+]+)/.exec(pm)?.[1] ?? ""
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha=${release}\npnpm-version=${pnpm}\n`)
