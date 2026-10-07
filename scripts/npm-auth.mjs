// User-level npm registry credentials, used by registry-auth.mjs.
//
// Credentials are always written USER-level, never into the project .npmrc.
// A committed `${VAR}` credential only works where VAR is set: without it
// pnpm 10 skips the whole project .npmrc and pnpm 11 sends the literal
// `${VAR}`, and pnpm 12 ignores env-var credentials in a project .npmrc
// altogether. So a project .npmrc only maps scopes to registries.
//   - pnpm: `pnpm config set //host/path/:_authToken <token>`. pnpm 10 hands
//     auth keys to npm, which stores them in ~/.npmrc, so the npm CLI behind
//     `npm view` / `npm publish` reads them too. pnpm 11 keeps them in its
//     own ~/.config/pnpm/auth.ini instead, which the npm CLI never reads:
//     see the README's note on pnpm 11 and later.
//   - bun: no `config set`, and it does not read pnpm's config; it does read
//     ~/.npmrc, which npm reads too. A later line wins.
import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const GITHUB_PACKAGES = "https://npm.pkg.github.com"

/** "https://host/path/" -> "//host/path": the protocol and one trailing slash go. */
export const registryBase = (url) => url.replace(/^https?:/, "").replace(/\/$/, "")

/** The key npm and pnpm read a registry's token from: "//host/path/:_authToken". */
export const credentialKey = (url) => `${registryBase(url)}/:_authToken`

/** Writes `token` as the user-level credential of `registry`; returns the key it wrote. */
export const writeCredential = ({ registry, token, packageManager = "pnpm" }) => {
  const key = credentialKey(registry)
  if (packageManager === "bun") {
    // the same key pnpm writes, slash included: "//npm.pkg.github.com:_authToken"
    // (no "/" before the colon) matches no registry
    appendFileSync(join(homedir(), ".npmrc"), `${key}=${token}\n`)
  } else {
    execFileSync("pnpm", ["config", "set", key, token], { stdio: ["ignore", "inherit", "inherit"] })
  }
  return key
}
