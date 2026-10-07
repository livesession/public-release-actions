import assert from "node:assert/strict"
import { afterEach, describe, test } from "node:test"
import { cmpSemver, isStable, maxStable, parseTag, tagGlob, tagName } from "../lib.mjs"

const DATE_BASED = "^\\d{6}\\."

describe("maxStable / isStable (ignore-versions)", () => {
  afterEach(() => {
    delete process.env.IGNORE_VERSIONS
  })

  test("without IGNORE_VERSIONS, a date-based version wins", () => {
    assert.equal(maxStable(["0.1.7", "202602.1.8"]), "202602.1.8")
    assert.equal(isStable("202602.1.8"), true)
  })

  test("with IGNORE_VERSIONS=^\\d{6}\\. the semver line wins", () => {
    process.env.IGNORE_VERSIONS = DATE_BASED
    assert.equal(maxStable(["0.1.7", "202602.1.8"]), "0.1.7")
    assert.equal(maxStable(["0.1.0", "0.1.7", "202602.0.0", "202602.1.8", "0.1.6"]), "0.1.7")
    assert.equal(isStable("202602.1.8"), false)
    assert.equal(isStable("0.1.7"), true)
    assert.equal(isStable("1000000.0.0"), true, "exactly six digits, then a dot")
    assert.equal(isStable("20260.1.0"), true, "five digits do not match")
  })

  test("only date-based versions: nothing is left", () => {
    process.env.IGNORE_VERSIONS = DATE_BASED
    assert.equal(maxStable(["202602.0.0", "202602.1.8"]), undefined)
  })

  test("prereleases never win, with or without the filter", () => {
    assert.equal(maxStable(["1.0.0-canary.abc1234", "0.0.0-canary.1", "0.9.0"]), "0.9.0")
    process.env.IGNORE_VERSIONS = DATE_BASED
    assert.equal(maxStable(["0.0.0-canary.1"]), undefined)
  })

  test("an empty IGNORE_VERSIONS ignores nothing", () => {
    process.env.IGNORE_VERSIONS = ""
    assert.equal(maxStable(["0.1.7", "202602.1.8"]), "202602.1.8")
  })

  test("the filter follows the environment between calls", () => {
    process.env.IGNORE_VERSIONS = DATE_BASED
    assert.equal(maxStable(["0.1.7", "202602.1.8"]), "0.1.7")
    process.env.IGNORE_VERSIONS = "^0\\."
    assert.equal(maxStable(["0.1.7", "1.2.3"]), "1.2.3")
    delete process.env.IGNORE_VERSIONS
    assert.equal(maxStable(["0.1.7", "202602.1.8"]), "202602.1.8")
  })

  test("an invalid regex fails loudly", () => {
    process.env.IGNORE_VERSIONS = "("
    assert.throws(() => maxStable(["1.0.0"]), /IGNORE_VERSIONS "\(" is not a valid regular expression/)
  })
})

test("cmpSemver compares numerically", () => {
  assert.ok(cmpSemver("0.10.0", "0.9.9") > 0)
  assert.ok(cmpSemver("1.0.0", "0.99.99") > 0)
  assert.equal(cmpSemver("1.2.3", "1.2.3"), 0)
  assert.deepEqual(["1.0.0", "0.1.7", "0.10.0"].sort(cmpSemver), ["0.1.7", "0.10.0", "1.0.0"])
})

describe("tag templates", () => {
  test("parseTag with the default template keeps the scope", () => {
    assert.deepEqual(parseTag("{name}@{version}", "@example/ui@1.0.0"), { name: "@example/ui", version: "1.0.0" })
    assert.deepEqual(parseTag("{name}@{version}", "@example/ui@202602.1.8"), {
      name: "@example/ui",
      version: "202602.1.8",
    })
    assert.deepEqual(parseTag("{name}@{version}", "unscoped@0.1.0"), { name: "unscoped", version: "0.1.0" })
  })

  test("parseTag with a version-only template", () => {
    assert.deepEqual(parseTag("v{version}", "v1.2.3"), { name: null, version: "1.2.3" })
    assert.equal(parseTag("v{version}", "release-1.2.3"), null)
  })

  test("tagName and tagGlob", () => {
    assert.equal(tagName("{name}@{version}", "@example/highlight", "1.0.0"), "@example/highlight@1.0.0")
    assert.equal(tagGlob("{name}@{version}", "@example/highlight"), "@example/highlight@*")
    assert.equal(tagGlob("v{version}", "ignored"), "v*")
  })
})
