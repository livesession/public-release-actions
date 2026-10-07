// Publishes every workspace package as a channel build versioned by commit
// SHA (0.0.0-<preid>.<shortsha>) under the <preid> dist-tag. All packages get
// the same canary version first, so workspace:^ rewrites stay internally
// consistent. Publish order is computed topologically from the workspace
// dependency graph. Idempotent: already-published versions are skipped.
//
// env: REGISTRY, CANARY_PREID (default "canary"),
//      CANARY_PUBLISH_COMMAND template with {name} {version} {tag}
//        (default: pnpm --filter "{name}" publish --tag {tag} --no-git-checks)
import { join } from "node:path"
import { listWorkspacePackages, readJson, sh, writeJson } from "./lib.mjs"

const REGISTRY = process.env.REGISTRY || "https://npm.pkg.github.com"
const PREID = process.env.CANARY_PREID || "canary"
const COMMAND = process.env.CANARY_PUBLISH_COMMAND || 'pnpm --filter "{name}" publish --tag {tag} --no-git-checks'

const sha = (process.env.GITHUB_SHA || sh("git rev-parse HEAD")).slice(0, 7)
const version = `0.0.0-${PREID}.${sha}`
console.log(`canary version: ${version}`)

const packages = listWorkspacePackages()
const names = new Set(packages.map((p) => p.name))

// set the shared canary version and collect the dependency graph
const graph = new Map()
for (const { name, dir } of packages) {
  const pkgPath = join(dir, "package.json")
  const pkg = readJson(pkgPath)
  pkg.version = version
  writeJson(pkgPath, pkg)
  const deps = new Set()
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const dep of Object.keys(pkg[field] ?? {})) if (names.has(dep)) deps.add(dep)
  }
  graph.set(name, deps)
}

// Kahn topological sort (dependencies first); cycles fall back to insertion order
const order = []
const pending = new Map([...graph].map(([k, v]) => [k, new Set(v)]))
while (pending.size > 0) {
  const ready = [...pending.keys()].filter((n) => pending.get(n).size === 0)
  if (ready.length === 0) {
    console.warn("dependency cycle detected — falling back to insertion order")
    order.push(...pending.keys())
    break
  }
  for (const n of ready) {
    order.push(n)
    pending.delete(n)
    for (const deps of pending.values()) deps.delete(n)
  }
}

const exists = (name) => {
  try {
    sh(`npm view "${name}@${version}" version --registry ${REGISTRY} 2>/dev/null`)
    return true
  } catch {
    return false
  }
}

for (const name of order) {
  if (exists(name)) {
    console.log(`skip ${name}@${version} (already published)`)
    continue
  }
  console.log(`publishing ${name}@${version} (${PREID})`)
  const cmd = COMMAND.replaceAll("{name}", name).replaceAll("{version}", version).replaceAll("{tag}", PREID)
  sh(cmd, { stdio: "inherit" })
}

console.log(`canary done: ${order.length} package(s) at ${version}`)
