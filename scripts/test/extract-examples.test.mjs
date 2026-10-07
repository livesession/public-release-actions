// extract-examples: which markdown blocks become linted workflows, and that
// every ```yaml block of README.md and examples/ is written, pointed at the
// local files of the reusable workflows. actionlint itself runs in CI (and
// locally with docker), not here.
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, test } from "node:test"
import { SOURCES, asWorkflow, extract, yamlBlocks } from "./extract-examples.mjs"
import { REPO, sandbox } from "./helpers.mjs"

describe("yamlBlocks", () => {
  test("```yaml and ```yml blocks only, in order; other fences are skipped", () => {
    const md = [
      "# t",
      "```sh",
      "echo no",
      "```",
      "```yaml",
      "name: a",
      "```",
      "```ini",
      "@x:registry=https://example.com/",
      "```",
      "```yml",
      "name: b",
      "```",
      "",
    ].join("\n")
    assert.deepEqual(yamlBlocks(md), ["name: a\n", "name: b\n"])
  })

  test("a block fenced inside a list item is dedented by its fence's indent", () => {
    const md = ["1. step:", "   ```yaml", "   jobs:", "     a:", "", "       runs-on: x", "   ```", ""].join("\n")
    assert.deepEqual(yamlBlocks(md), ["jobs:\n  a:\n\n    runs-on: x\n"])
  })
})

describe("asWorkflow", () => {
  test("a workflow stays whole; the reusable workflow refs point at the local files", () => {
    const block = "name: Canary\non: push\njobs:\n  c:\n    uses: livesession/public-release-actions/.github/workflows/canary.yml@v0\n"
    assert.equal(
      asWorkflow(block, "x"),
      "name: Canary\non: push\njobs:\n  c:\n    uses: ./.github/workflows/reusable-canary.yml\n",
    )
    assert.equal(asWorkflow("# a comment first\non: push\n", "x"), "# a comment first\non: push\n")
  })

  test("a jobs: snippet gets a name and a trigger", () => {
    assert.equal(asWorkflow("jobs:\n  a: {}\n", "README.md yaml block 0"), "name: README.md yaml block 0\non: push\njobs:\n  a: {}\n")
  })

  test("anything else fails, naming the block", () => {
    assert.throws(() => asWorkflow("with:\n  registry: x\n", "README.md yaml block 3"), /README\.md yaml block 3: .*jobs: snippet/)
  })
})

test("every ```yaml block of README.md and examples/ is written as a workflow", (t) => {
  const box = sandbox(t)
  const written = extract(box.cwd)
  const workflows = join(box.cwd, ".github", "workflows")
  for (const { file, prefix } of SOURCES) {
    const fences = readFileSync(join(REPO, file), "utf8").match(/^ *```ya?ml[ \t]*$/gm) ?? []
    assert.equal(written.filter((name) => name.startsWith(`${prefix}-`)).length, fences.length, file)
  }
  assert.ok(written.some((name) => name.startsWith("example-")), "examples/release-workflows.md has examples")
  for (const name of written) {
    const text = readFileSync(join(workflows, name), "utf8")
    assert.doesNotMatch(text, /livesession\/public-release-actions\/\.github\/workflows\//, `${name}: a ref left unrewritten`)
    for (const [, target] of text.matchAll(/uses: \.\/(\.github\/workflows\/\S+)/g)) {
      assert.ok(existsSync(join(box.cwd, target)), `${name}: ${target} does not exist`)
    }
  }
})
