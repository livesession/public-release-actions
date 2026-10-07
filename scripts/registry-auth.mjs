// Writes the user-level registry credentials before the install, or before
// the publish.
//
//   install  the install token goes to github-registry (GitHub Packages, where
//            dependencies published to GitHub Packages live), and to
//            `registry` as well when that is some other registry.
//   publish  the publish token goes to `registry`.
//
// With the default inputs (registry = github-registry = GitHub Packages) this
// makes exactly one `pnpm config set //npm.pkg.github.com/:_authToken <token>`
// per step; scripts/test/registry-auth.test.mjs pins that against the plain
// shell form of the same step.
//
// env: MODE             install | publish
//      REGISTRY         the workflow's publish registry
//      GH_REGISTRY      GitHub Packages registry for the install ("" = none)
//      PACKAGE_MANAGER  pnpm | bun
//      REGISTRY_AUTH_TOKEN
import { GITHUB_PACKAGES, credentialKey, writeCredential } from "./npm-auth.mjs"

const MODE = process.env.MODE
const REGISTRY = process.env.REGISTRY || GITHUB_PACKAGES
const GH_REGISTRY = process.env.GH_REGISTRY ?? GITHUB_PACKAGES
const PACKAGE_MANAGER = process.env.PACKAGE_MANAGER || "pnpm"
const TOKEN = process.env.REGISTRY_AUTH_TOKEN ?? ""

if (MODE !== "install" && MODE !== "publish") {
  console.error(`registry-auth: mode must be "install" or "publish", not "${MODE ?? ""}"`)
  process.exit(1)
}

const wanted = MODE === "install" ? [GH_REGISTRY, REGISTRY] : [REGISTRY]
const targets = new Map() // credential key -> registry, first one wins
for (const registry of wanted.filter(Boolean)) {
  const key = credentialKey(registry)
  if (!targets.has(key)) targets.set(key, registry)
}

if (targets.size && !TOKEN) {
  console.warn(`registry-auth (${MODE}): no token — writing no credentials`)
  process.exit(0)
}
for (const registry of targets.values()) {
  const key = writeCredential({ registry, token: TOKEN, packageManager: PACKAGE_MANAGER })
  console.log(`registry auth (${MODE}): ${key}`)
}
