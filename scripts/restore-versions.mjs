// Restores real package versions into package.json files. In-repo versions
// are permanent placeholders (default 0.0.0-dev); the truth is the max of
// release git tags and stable registry versions. SEEDS covers packages that
// have never been published. Writes a manifest consumed by the other scripts.
//
// env: REGISTRY, PLACEHOLDER, SEEDS (JSON name->version), TAG_TEMPLATE,
//      IGNORE_VERSIONS (regex: matching versions are not version sources)
import { join } from "node:path"
import {
  DEFAULT_TAG_TEMPLATE,
  cmpSemver,
  ignoredVersions,
  listWorkspacePackages,
  maxStable,
  parseTag,
  readJson,
  sh,
  tagGlob,
  writeJson,
} from "./lib.mjs"

const REGISTRY = process.env.REGISTRY || "https://npm.pkg.github.com"
const PLACEHOLDER = process.env.PLACEHOLDER || "0.0.0-dev"
const TAG_TEMPLATE = process.env.TAG_TEMPLATE || DEFAULT_TAG_TEMPLATE
const SEEDS = JSON.parse(process.env.SEEDS || "{}")

const fromTags = (name) => {
  const tags = sh(`git tag -l "${tagGlob(TAG_TEMPLATE, name)}"`).split("\n").filter(Boolean)
  const versions = tags.map((t) => parseTag(TAG_TEMPLATE, t)).filter((p) => p && (p.name === null || p.name === name)).map((p) => p.version)
  return maxStable(versions)
}

const fromRegistry = (name) => {
  try {
    // 2>/dev/null: a 404 is the expected answer for never-published packages
    const out = sh(`npm view "${name}" versions --json --registry ${REGISTRY} 2>/dev/null`)
    const versions = JSON.parse(out)
    return maxStable(Array.isArray(versions) ? versions : [versions])
  } catch {
    return undefined
  }
}

try {
  if (ignoredVersions()) console.log(`ignoring versions matching ${ignoredVersions()} (ignore-versions)`)
} catch (err) {
  console.error(`ERROR: ${err.message}`)
  process.exit(1)
}

const manifest = {}
for (const { name, dir } of listWorkspacePackages()) {
  const pkgPath = join(dir, "package.json")
  const pkg = readJson(pkgPath)
  if (pkg.version !== PLACEHOLDER) {
    console.warn(`skip ${name}: version is ${pkg.version}, expected placeholder ${PLACEHOLDER}`)
    continue
  }
  const tag = fromTags(name)
  const reg = fromRegistry(name)
  const candidates = [tag, reg].filter(Boolean)
  if (candidates.length === 0 && !(name in SEEDS)) {
    // no tag, no registry answer, no seed: either a genuinely new package
    // (add it to seeds) or a silently failed registry read (missing
    // packages:read permission / auth) — starting at 0.0.0 unprompted would
    // publish wrong versions, so fail loudly instead.
    console.error(
      `ERROR: no version source for ${name} (tags: none, registry: unreadable/empty, seed: none).\n` +
        `If this package is genuinely new, add it to the seeds input; otherwise check the registry auth ` +
        `(GitHub Packages: the calling job needs "packages: read"; another registry: a registry-token or ` +
        `install-token secret that can read it).`,
    )
    process.exit(1)
  }
  const version = candidates.length ? candidates.sort(cmpSemver).pop() : SEEDS[name]

  pkg.version = version
  writeJson(pkgPath, pkg)
  manifest[name] = { path: pkgPath, dir, restored: version }
  console.log(`${name}: ${version} (tags: ${tag ?? "-"}, registry: ${reg ?? "-"})`)
  if (!ignoredVersions() && /^\d{6}\./.test(version)) {
    console.warn(
      `warning: ${name} restored the date-based version ${version}. If that line is not this package's semver ` +
        `(e.g. YYYYMM.x.y next to x.y.z), set ignore-versions: '^\\d{6}\\.'`,
    )
  }
}

writeJson(".beachball-restore.json", manifest)
console.log("manifest written to .beachball-restore.json")
