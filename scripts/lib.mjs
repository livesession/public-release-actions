// Shared helpers for the release scripts. Scripts always operate on the
// CONSUMER repository (process.cwd()); this repository only provides the code.
import { execSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const ROOT = process.cwd()

// execSync returns null when stdio is inherited — normalize to ""
export const sh = (cmd, opts = {}) =>
  execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts })?.trim() ?? ""

export const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"))
export const writeJson = (path, data) => writeFileSync(join(ROOT, path), JSON.stringify(data, null, 2) + "\n")

/** Workspace packages via the package manager (pnpm today; extend here for others). */
export const listWorkspacePackages = () => {
  const out = sh("pnpm m ls --json --depth -1")
  const list = JSON.parse(out)
  return list
    .filter((p) => p.name && p.path && !p.private)
    .map((p) => ({ name: p.name, dir: p.path.startsWith(ROOT) ? p.path.slice(ROOT.length + 1) || "." : p.path }))
    .filter((p) => p.dir !== ".") // exclude the workspace root itself
}

/* ── semver (stable x.y.z only — prereleases never win a restore) ─────── */
export const STABLE = /^\d+\.\d+\.\d+$/
export const cmpSemver = (a, b) => {
  const A = a.split(".").map(Number)
  const B = b.split(".").map(Number)
  return A[0] - B[0] || A[1] - B[1] || A[2] - B[2]
}

// IGNORE_VERSIONS (the ignore-versions input): a JS regular expression. Stable
// versions it matches are invisible to the restore (tags and registry) and to
// the publish guards, e.g. "^\d{6}\." for date-based versions (YYYYMM.x.y) that
// another release tool published next to the semver line and that would
// otherwise always sort above it.
let ignored = { source: "", regex: null }
export const ignoredVersions = () => {
  const source = process.env.IGNORE_VERSIONS || ""
  if (source !== ignored.source) {
    let regex = null
    if (source) {
      try {
        regex = new RegExp(source)
      } catch (err) {
        throw new Error(`IGNORE_VERSIONS "${source}" is not a valid regular expression: ${err.message}`)
      }
    }
    ignored = { source, regex }
  }
  return ignored.regex
}
/** A stable x.y.z version that ignore-versions does not hide. */
export const isStable = (v) => STABLE.test(v) && !ignoredVersions()?.test(v)
export const maxStable = (versions) => versions.filter(isStable).sort(cmpSemver).pop()

/* ── tag templates: "{name}@{version}" (default), "v{version}", … ─────── */
export const DEFAULT_TAG_TEMPLATE = "{name}@{version}"

export const tagName = (template, name, version) => template.replaceAll("{name}", name).replaceAll("{version}", version)

export const tagGlob = (template, name) => template.replaceAll("{name}", name).replaceAll("{version}", "*")

/** Parse a tag back into {name, version}; returns null when it doesn't match. */
export const parseTag = (template, tag) => {
  const pattern = template
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace("\\{name\\}", "(?<name>.+)")
    .replace("\\{version\\}", "(?<version>[^@]+)")
  const m = tag.match(new RegExp(`^${pattern}$`))
  return m ? { name: m.groups.name ?? null, version: m.groups.version } : null
}

/* ── consumer beachball config (tolerant: missing config is fine) ─────── */
export const loadBeachballConfig = async () => {
  for (const file of ["beachball.config.js", "beachball.config.cjs", "beachball.config.mjs"]) {
    try {
      const mod = await import(join("file://", ROOT, file))
      return mod.default ?? mod
    } catch (err) {
      if (err.code !== "ERR_MODULE_NOT_FOUND" && !/Cannot find module/.test(String(err))) {
        console.warn(`warning: failed to load ${file}: ${err.message}`)
      }
    }
  }
  try {
    const pkg = readJson("package.json")
    if (pkg.beachball) return pkg.beachball
  } catch {
    /* no root package.json */
  }
  try {
    return readJson(".beachballrc.json")
  } catch {
    return {}
  }
}
