// Publishes ONE package at the semver carried by the pushed release tag.
// Runs after restore-versions.mjs, which has already written real versions
// into every package.json — the just-pushed tag is the max for its package,
// so the restored version equals the tag version, and the package manager
// rewrites internal workspace ranges against the other restored versions.
//
// env: REGISTRY, TAG_TEMPLATE,
//      PUBLISH_COMMAND template with {name} {version}
//        (default: pnpm --filter "{name}" publish --no-git-checks)
import { DEFAULT_TAG_TEMPLATE, parseTag, readJson, sh } from "./lib.mjs"

const REGISTRY = process.env.REGISTRY || "https://npm.pkg.github.com"
const TAG_TEMPLATE = process.env.TAG_TEMPLATE || DEFAULT_TAG_TEMPLATE
const COMMAND = process.env.PUBLISH_COMMAND || 'pnpm --filter "{name}" publish --no-git-checks'

const ref = process.env.GITHUB_REF_NAME || process.argv[2]
const parsed = ref ? parseTag(TAG_TEMPLATE, ref) : null
if (!parsed) {
  console.error(`tag "${ref ?? ""}" does not match template "${TAG_TEMPLATE}"`)
  process.exit(1)
}
const { name, version } = parsed

const manifest = readJson(".beachball-restore.json")
const info = manifest[name]
if (!info) {
  console.error(`${name} is not a known workspace package`)
  process.exit(1)
}
const onDisk = readJson(info.path).version
if (onDisk !== version) {
  console.error(`version mismatch: tag says ${version}, restored package.json says ${onDisk} — refusing to publish`)
  process.exit(1)
}

try {
  sh(`npm view "${name}@${version}" version --registry ${REGISTRY} 2>/dev/null`)
  console.log(`${name}@${version} already on the registry — nothing to do`)
  process.exit(0)
} catch {
  /* not published yet */
}

console.log(`publishing ${name}@${version}`)
try {
  sh(COMMAND.replaceAll("{name}", name).replaceAll("{version}", version), { stdio: "inherit" })
} catch (err) {
  // a Publish Latest run (another concurrency group) may have published it meanwhile
  try {
    if (sh(`npm view "${name}@${version}" version --registry ${REGISTRY} 2>/dev/null`) === version) {
      console.log(`${name}@${version} was published by another run meanwhile — nothing to do`)
      process.exit(0)
    }
  } catch {
    /* still not there */
  }
  throw err
}
console.log(`published ${name}@${version}`)
