// Writes every ```yaml block of README.md and examples/release-workflows.md as
// a workflow in <dir>/.github/workflows, with the reusable workflows placed
// next to them and the
// `uses: livesession/public-release-actions/.github/workflows/<x>.yml@<ref>`
// lines pointed at those local files, so actionlint checks each example's
// inputs and secrets against the real workflow_call definitions:
//
//   node scripts/test/extract-examples.mjs "$dir"
//   docker run --rm -v "$dir":/repo -w /repo rhysd/actionlint:1.7.12
//
// A block is either a whole workflow (its first key is `name:` or `on:`) or a
// `jobs:` snippet, which gets the minimum a workflow file needs. A block
// fenced inside a list item is dedented by its fence's indent. Any other
// ```yaml block fails the run: fence it as something else.
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { REPO } from "./helpers.mjs"

/** The markdown files whose ```yaml blocks are linted, and the prefix of their workflow files. */
export const SOURCES = [
  { file: "README.md", prefix: "readme" },
  { file: "examples/release-workflows.md", prefix: "example" },
]

/** The ```yaml (or ```yml) blocks of a markdown text, each dedented by its fence's indent. */
export const yamlBlocks = (markdown) =>
  [...markdown.matchAll(/^( *)```ya?ml[ \t]*\n([\s\S]*?)^\1```[ \t]*$/gm)].map(([, indent, body]) =>
    body
      .split("\n")
      .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line.trimStart()))
      .join("\n"),
  )

/** A block as a workflow file; throws, naming the block, when it is neither a workflow nor a jobs: snippet. */
export const asWorkflow = (block, label) => {
  const firstKey = block.split("\n").find((line) => line.trim() && !line.trimStart().startsWith("#")) ?? ""
  let workflow
  if (/^(name|on):/.test(firstKey)) workflow = block
  else if (/^jobs:/.test(firstKey)) workflow = `name: ${label}\non: push\n${block}`
  else throw new Error(`${label}: a \`\`\`yaml block must be a workflow (name: or on: first) or a jobs: snippet`)
  return workflow.replace(
    /uses: livesession\/public-release-actions\/\.github\/workflows\/([\w-]+\.yml)@\S+/g,
    "uses: ./.github/workflows/reusable-$1",
  )
}

/** Writes the reusable workflows and every example into <dir>; returns the example file names. */
export const extract = (dir) => {
  const workflows = join(dir, ".github", "workflows")
  mkdirSync(workflows, { recursive: true })
  execFileSync("git", ["init", "-q", dir]) // actionlint finds the project by its git root
  for (const file of readdirSync(join(REPO, ".github", "workflows"))) {
    if (file.endsWith(".yml")) copyFileSync(join(REPO, ".github", "workflows", file), join(workflows, `reusable-${file}`))
  }
  const written = []
  for (const { file, prefix } of SOURCES) {
    yamlBlocks(readFileSync(join(REPO, file), "utf8")).forEach((block, i) => {
      const name = `${prefix}-${String(i).padStart(2, "0")}.yml`
      writeFileSync(join(workflows, name), asWorkflow(block, `${file} yaml block ${i}`))
      written.push(name)
    })
  }
  return written
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2]
  if (!dir) {
    console.error("usage: node scripts/test/extract-examples.mjs <dir>")
    process.exit(1)
  }
  try {
    const written = extract(dir)
    for (const { file, prefix } of SOURCES) {
      console.log(`${file}: ${written.filter((name) => name.startsWith(`${prefix}-`)).length} yaml blocks`)
    }
    console.log(`written to ${join(dir, ".github", "workflows")}`)
  } catch (err) {
    console.error(`extract-examples: ${err.message}`)
    process.exit(1)
  }
}
