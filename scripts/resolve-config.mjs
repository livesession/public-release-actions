// Emits consumer-config-derived values as GitHub Actions step outputs:
//   change_dir  — beachball changeDir (default "change")
//   change_glob — pattern for the should-release action
import { appendFileSync } from "node:fs"
import { loadBeachballConfig } from "./lib.mjs"

const config = await loadBeachballConfig()
const changeDir = config.changeDir || "change"

const out = `change_dir=${changeDir}\nchange_glob=${changeDir}/*.json\n`
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, out)
console.log(out.trim())
