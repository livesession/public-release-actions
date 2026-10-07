# Consumer workflows — the six files for `.github/workflows/`

Add these six workflows to the repository that publishes the packages, then
adjust the placeholders (`@your-scope/...`, the build command). `@v1` pins the
reusable workflow file; the actions it runs are always
`livesession/public-release-actions/actions/*@v1`, so a workflow works once
the `v1` tag points at a commit that has it.

## check.yml — PR gate

```yaml
name: PR
on:
  pull_request:
jobs:
  change-files:
    uses: livesession/public-release-actions/.github/workflows/check.yml@v1
```

## canary.yml — channel build on every default-branch push

```yaml
name: Canary
on:
  push:
    branches: [master]
  workflow_dispatch:
concurrency:
  group: canary-${{ github.ref }}
  cancel-in-progress: true
jobs:
  canary:
    permissions:
      contents: read
      packages: write
    uses: livesession/public-release-actions/.github/workflows/canary.yml@v1
    with:
      build-command: pnpm -w run build   # adjust to your repo
```

## release-pr.yml — the bot-owned Release PR

```yaml
name: Release PR
on:
  push:
    branches: [master]
  workflow_dispatch:
    inputs:
      scope:
        description: "Partial release: comma-separated package names (empty = everything)"
        required: false
        default: ""
concurrency: ${{ github.workflow }}-${{ github.ref }}   # required (should-release batch mode)
jobs:
  release-pr:
    permissions:
      contents: write
      pull-requests: write
      actions: read
      packages: read   # restore-versions reads published versions from the registry
    uses: livesession/public-release-actions/.github/workflows/release-pr.yml@v1
    with:
      scope: ${{ inputs.scope || '' }}
      seeds: '{"@your-scope/your-package": "0.0.0"}'   # only for never-published packages
```

## tag-release.yml — tags on Release PR merge

```yaml
name: Tag Release
on:
  push:
    branches: [master]
    paths: [".release/latest.json"]
  workflow_dispatch:
jobs:
  tag:
    permissions:
      contents: write
    uses: livesession/public-release-actions/.github/workflows/tag-release.yml@v1
    secrets:
      # a PAT with contents: write. Tags pushed by GITHUB_TOKEN start no workflow,
      # so without it the tags appear and Publish Tag never runs
      tag-token: ${{ secrets.TAG_RELEASE_TOKEN }}
```

## publish-tag.yml — semver publish per pushed tag

```yaml
name: Publish Tag
on:
  push:
    tags: ["@your-scope/**"]   # match your tag-template
# one group per tag: a shared group keeps one run going and one queued and
# cancels the rest, so most packages of a multi-package release never publish
concurrency:
  group: publish-${{ github.ref }}
  cancel-in-progress: false
jobs:
  publish:
    permissions:
      contents: read
      packages: write
    uses: livesession/public-release-actions/.github/workflows/publish-tag.yml@v1
    with:
      build-command: pnpm -w run build   # adjust to your repo
```

## publish-latest.yml — publish the latest release by hand

Publishes the release in `.release/latest.json` with no tag event: the
recovery for a release whose tags never started Publish Tag, or that half
failed. Run it from the Actions tab ("Run workflow") on the default branch:
`dry-run` is ticked by default, so the first run shows the plan; untick it
to publish.

```yaml
name: Publish Latest
on:
  workflow_dispatch:
    inputs:
      packages:
        description: "Comma-separated package names (empty = the whole release)"
        required: false
        default: ""
      dry-run:
        description: "Only show what would be published (untick to publish)"
        type: boolean
        default: true
concurrency:
  group: publish-latest
  cancel-in-progress: false
jobs:
  publish:
    permissions:
      contents: read
      packages: write
    uses: livesession/public-release-actions/.github/workflows/publish-latest.yml@v1
    with:
      build-command: pnpm -w run build   # match publish-tag.yml
      packages: ${{ inputs.packages }}
      dry-run: ${{ inputs.dry-run }}
```

## Another registry (for example the public npm registry)

The callers above publish to GitHub Packages with the workflow `GITHUB_TOKEN`.
For any other npm registry, every workflow that touches the registry (canary,
release-pr, publish-tag, publish-latest) gets the same three settings:

- `registry`: the registry URL (and the same value in `beachball.config`);
- `registry-token`: a token that may publish there, e.g. an npm automation
  token stored as a repository secret. release-pr only reads, so a read-only
  token is enough for it;
- `publish-command` (and `canary-publish-command` in canary.yml) when the
  default needs a flag: a scoped package on the public npm registry is
  private unless `--access public` is passed or `publishConfig.access` is set
  in its package.json.

`packages: write` is not needed. `github-registry` keeps its default when the
install reads a dependency from GitHub Packages (pass a read-only token as
`install-token`); set it to `""` when nothing comes from there.

```yaml
name: Publish Tag
on:
  push:
    tags: ["@your-scope/**"]
concurrency:
  group: publish-${{ github.ref }}
  cancel-in-progress: false
jobs:
  publish:
    permissions:
      contents: read
    uses: livesession/public-release-actions/.github/workflows/publish-tag.yml@v1
    secrets:
      registry-token: ${{ secrets.NPM_TOKEN }}
    with:
      registry: https://registry.npmjs.org/
      github-registry: ""
      publish-command: pnpm --filter "{name}" publish --no-git-checks --access public
      build-command: pnpm -w run build   # adjust to your repo
```

The project `.npmrc` holds the scope line only, with no `_authToken` line:

```ini
@your-scope:registry=https://registry.npmjs.org/
```

The workflows write the token user-level before the install and before the
publish; locally, `pnpm config set //registry.npmjs.org/:_authToken <token>`
does the same (see "Credentials are user-level" in the
[README's operational notes](../README.md#operational-notes)).
