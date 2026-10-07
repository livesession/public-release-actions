# public-release-actions

Reusable GitHub Actions workflows for releasing npm packages from a pnpm (or
bun) workspace: change-file driven versioning with
[beachball](https://microsoft.github.io/beachball/v2/), **placeholder
versions in git**, a canary channel build on every default-branch push, a
bot-owned Release PR as the release approval, one git tag per released
package, a publish per tag, and a manual Publish Latest for recovery.
GitHub Packages works out of the box with the workflow `GITHUB_TOKEN`; any
other npm registry works through the `registry` input and a `registry-token`
secret.

```
feature PR (with change file)                       ← pnpm change; check.yml enforces
        │ merge
        ▼
default branch ──▶ canary publish                   0.0.0-canary.<sha> @canary  (every push)
              └──▶ Release PR (bot-owned)           changelogs + consumed change files + manifest
                        │ merge  = release approval
                        ▼
                 release tags (name@version)        tag-release.yml, from the manifest
                        │ one workflow run per tag
                        ▼
                 semver registry publish            publish-tag.yml
                        ⋮ or, by hand, with no tag event at all
                 publish the manifest's release     publish-latest.yml (Run workflow)
```

## The model

- **package.json versions in git are permanent placeholders** (`0.0.0-dev`).
  Nobody hand-bumps; PRs carry no version churn. Real versions live in release
  git tags, the registry, and generated CHANGELOGs.
- **Change files are the input**: authors run `pnpm change` once per PR
  (bump type + changelog sentence); CI enforces it. Everything downstream —
  versions, changelogs, tags, publishes — is generated.
- **Merging the Release PR is the only human release action.** Leaving it open
  costs nothing: it keeps absorbing newly merged features, canaries keep
  flowing. A partial release is a `scope` dispatch input (per-package
  granularity; lockstep groups auto-expand).

## Adopting it in a repository

1. **beachball setup**: `pnpm add -D -w beachball`; root scripts
   `"change": "beachball change"`, `"checkchange": "beachball check"`;
   a `beachball.config.js` with at least:
   ```js
   module.exports = {
     registry: "https://npm.pkg.github.com", // npm CLI flags beat publishConfig
     branch: "origin/master",
     gitTags: false,          // tags are created by these workflows instead
     ignorePatterns: [...],   // dev-only files that never need change files
     groups: [...],           // optional lockstep groups
     changeDir: ".change",    // optional; auto-detected by the workflows
   }
   ```
2. **Placeholders**: set every publishable package's version to `0.0.0-dev`.
3. **`.npmrc`**: one line per scope mapping it to its registry, and no
   credential line, e.g. `@your-scope:registry=https://npm.pkg.github.com/`.
   The workflows write the tokens user-level before the install and before
   the publish (see "Credentials are user-level" below).
4. **Registry auth**: GitHub Packages works with the built-in `GITHUB_TOKEN`
   (`permissions: packages: write` on the publishing jobs, `packages: read`
   on release-pr). Other registries take the `registry-token` secret. When
   the **install** needs more than the repository's own `GITHUB_TOKEN` can
   read — a dependency that is another repository's GitHub package — pass a
   classic PAT with only `read:packages` as `install-token`, not as
   `registry-token`: the install then reads with it while the canary and
   tag publishes keep writing with `registry-token`, else the workflow
   `GITHUB_TOKEN`. A read-only PAT passed as `registry-token` makes every
   publish fail with 403 "The token provided does not match expected scopes".
5. **Workflows**: add the six callers from
   [`examples/release-workflows.md`](examples/release-workflows.md).
6. **First release seeds**: packages never published before get their starting
   version from the `seeds` input (`{"@your-scope/your-package": "0.0.0"}` →
   the first minor bump lands on 0.1.0).

## Publishing to another registry

Set `registry` to the registry URL (in every caller that touches the
registry and in `beachball.config`) and pass a token that may publish there
as `registry-token`, e.g. an npm automation token for
`https://registry.npmjs.org/`. A scoped package on the public npm registry is
private unless the publish says otherwise: either set
`"publishConfig": { "access": "public" }` in each package.json, or pass the
flag through the publish commands:

```yaml
jobs:
  publish:
    permissions:
      contents: read   # no packages: write — nothing goes to GitHub Packages
    uses: livesession/public-release-actions/.github/workflows/publish-tag.yml@v1
    secrets:
      registry-token: ${{ secrets.NPM_TOKEN }}
    with:
      registry: https://registry.npmjs.org/
      github-registry: ""   # keep the default when a dependency comes from GitHub Packages
      publish-command: pnpm --filter "{name}" publish --no-git-checks --access public
```

canary.yml takes the same `registry` and `registry-token`, and the flag goes
into `canary-publish-command` (`pnpm --filter "{name}" publish --tag {tag}
--no-git-checks --access public`). release-pr.yml only reads the registry, so
a read-only token is enough there. `github-registry` is the registry the
install token is always written for: keep its default when the install reads
a dependency from GitHub Packages (with a read-only `install-token`), and set
it to `""` when nothing comes from there. The full set of callers is in
[`examples/release-workflows.md`](examples/release-workflows.md#another-registry-for-example-the-public-npm-registry).

## Inputs and secrets

| Input | Default | Workflows | Notes |
|---|---|---|---|
| `registry` | `https://npm.pkg.github.com` | canary, release-pr, publish-tag, publish-latest | any npm registry; the publish target and the version source |
| `node-version` | `22` | check, canary, release-pr, publish-tag, publish-latest | |
| `pnpm-version` | `10` | canary, release-pr, publish-tag, publish-latest | see "pnpm 11 and later" below before raising it |
| `package-manager` | `pnpm` | canary, release-pr | `pnpm` or `bun`; only toolchain setup, registry auth and the install differ |
| `bun-version` | `latest` | canary, release-pr | with `package-manager: bun`; pin it to the repo's own bun |
| `build-command` | `pnpm -r run build` | canary, publish-tag, publish-latest | runs before the publish; empty string skips |
| `placeholder-version` | `0.0.0-dev` | release-pr, publish-tag, publish-latest | |
| `tag-template` | `{name}@{version}` | release-pr, tag-release, publish-tag, publish-latest | e.g. `v{version}` for a single-package repo |
| `canary-preid` | `canary` | canary | prerelease id AND dist-tag |
| `canary-publish-command` | `pnpm --filter "{name}" publish --tag {tag} --no-git-checks` | canary | `{name}` `{version}` `{tag}` substituted |
| `publish-command` | `pnpm --filter "{name}" publish --no-git-checks` | publish-tag, publish-latest | `{name}` `{version}` substituted |
| `seeds` | `{}` | release-pr, publish-tag, publish-latest | first-publish starting versions, JSON name → version |
| `release-branch` | `release/next` | release-pr | the bot-owned PR branch |
| `manifest-path` | `.release/latest.json` | release-pr, tag-release, publish-latest | the release manifest |
| `scope` | `""` | release-pr | partial release: comma-separated package names |
| `packages` | `""` | publish-latest | comma-separated names; empty = the whole manifest |
| `dry-run` | `false` | publish-latest | show what would be published, publish nothing |
| `github-registry` | `https://npm.pkg.github.com` | canary, release-pr, publish-tag, publish-latest | the registry the install token (`install-token`, else `registry-token`, else `GITHUB_TOKEN`) is always written for, so a dependency from GitHub Packages installs even when `registry` is another one; `""` = none |
| `ignore-versions` | `""` | release-pr, publish-tag, publish-latest | a JS regex; matching versions are invisible to the version restore (tags and registry) and to the publish guards. `'^\d{6}\.'` hides date-based versions another tool published (see "Ignored versions") |

| Secret | Workflows | Notes |
|---|---|---|
| `registry-token` | canary, release-pr, publish-tag, publish-latest | the publish auth (release-pr only installs); default the workflow `GITHUB_TOKEN` |
| `install-token` | canary, release-pr, publish-tag, publish-latest | install-only auth (a read-only PAT); the publish never uses it |
| `tag-token` | tag-release | PAT (`contents: write`) that pushes the tags, so Publish Tag starts |

## How the pieces fit

The reusable workflows in `.github/workflows/` run composite actions from
`actions/`, which run the Node scripts in `scripts/` (no dependencies beyond
Node itself) against the calling repository's checkout. The workflows
reference the actions at the major tag `@v1`, so a caller pins only its
`uses:` line and the whole toolchain versions together: move the `v1` tag on
every release of this repository. To try a branch end to end ahead of a tag,
push a throwaway branch that rewrites the `actions/*@v1` references to
itself and point a caller's `uses:` at it.

One composite is useful on its own, in any job that installs from GitHub
Packages or another authenticated registry:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: read
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - uses: livesession/public-release-actions/actions/registry-auth@v1
        with:
          mode: install
          token: ${{ secrets.GH_PACKAGES_READ_TOKEN || github.token }}
      - run: pnpm install --frozen-lockfile
```

Its inputs: `mode` (`install` | `publish`), `registry`, `github-registry`,
`package-manager` (`pnpm` | `bun`) and `token`.

## Operational notes

- All publishes are **idempotent** (registry existence pre-checks): re-running
  a failed workflow or re-pushing a tag is always safe.
- **Recovery: Publish Latest.** A release whose tags exist but never
  published (no tag event, a cancelled run, a half-failed multi-package
  release) is finished by running the caller's Publish Latest workflow by
  hand: it reads the manifest (`.release/latest.json`), checks out the
  release's own commit (where its tags point, else the manifest's last
  change, never the branch's newer code) and publishes each `name@version`
  the registry lacks, dependencies first. `dry-run` shows the plan first;
  `packages` narrows it. It publishes only a merged release (the run must be
  on the default branch, and the release commit in its history, so an open
  Release PR is never published), and a package only once every workspace
  package it depends on is on the registry at the version it pins. It
  refuses a manifest older than what tags or the registry already hold, and
  tags of one release that point at different commits.
- Publish Latest and Publish Tag are not serialized against each other (their
  concurrency groups differ). Both treat a version another run published
  meanwhile as done.
- **A tag publishes only if its push starts a workflow.** Three rules, all
  GitHub's:
  - tags pushed by `GITHUB_TOKEN` start no workflow, so tag-release needs a
    `tag-token` PAT (`contents: write`);
  - GitHub creates no push event for tags when more than three are pushed at
    once, so tag-release pushes each tag on its own. When re-pushing tags by
    hand to recover, do the same. Each push is retried (GitHub answers one
    with a 5xx now and then), a tag that still fails never stops the others,
    and the run then fails naming it: re-run Tag Release, which pushes only
    the missing tags;
  - a publish-tag caller needs a concurrency group per tag
    (`publish-${{ github.ref }}`): a shared group cancels all but one running
    and one queued run.
- Bot-created Release PRs don't trigger `pull_request` workflows with the
  default token; if branch protection requires checks on it, create the PR
  with a PAT/App token.
- `should-release` batch mode requires the caller's
  `concurrency: ${{ github.workflow }}-${{ github.ref }}` (queue, never cancel).
- **Credentials are user-level.** A project `.npmrc` maps scopes to
  registries and holds no `_authToken` line. In CI, the `registry-auth` step
  writes the token user-level before the install and before the publish:
  `pnpm config set //host/path/:_authToken …` (pnpm 10 hands auth keys to
  npm, which stores them in `~/.npmrc`, so the `npm view` / `npm publish`
  calls read them too), or a line appended to `~/.npmrc` for bun (a later
  line wins; the key keeps the `/` before `:_authToken`, without it the line
  matches no registry). Locally, developers do the same once with
  `pnpm config set` (for GitHub Packages: a classic PAT with
  `read:packages`).
- **Why no `${VAR}` credential line.** A committed `${VAR}` credential works
  only where `VAR` is set. Without it, pnpm 10 skips the whole project
  `.npmrc` (its scope lines too), and pnpm 11 sends the literal `${VAR}` over
  a good user-level token; pnpm 12 ignores env-var credentials in a project
  `.npmrc` altogether. A repository that keeps a
  `//npm.pkg.github.com/:_authToken=${GITHUB_NPM_TOKEN}` line still installs
  and publishes in CI, because the workflows set `GITHUB_NPM_TOKEN` at job
  level (the install token, then the publish token in the publish step);
  outside CI it works only where the developer's shell sets it.
- **pnpm 11 and later keep credentials out of `~/.npmrc`.** The pnpm writer
  above relies on `pnpm config set` landing in `~/.npmrc`, which holds up to
  pnpm 10 only. pnpm 11 writes auth keys to its own config
  (`~/.config/pnpm/auth.ini` on Linux), which the npm CLI never reads, so the
  `npm view` of restore-versions and publish-manifest, and `npm publish`
  behind `pnpm publish`, would reach the registry with no token. A
  repository that publishes to or restores from GitHub Packages, or any other
  registry that needs the token for reads, keeps the default
  `pnpm-version: 10`.
- **Which token goes where** (`registry-auth`): before the install,
  `github-registry` gets the install token, and `registry` too when it is
  another registry; before the publish, `registry` gets the publish token.
  With the default inputs this is exactly one
  `pnpm config set //npm.pkg.github.com/:_authToken` per step
  (`scripts/test/registry-auth.test.mjs` pins it).
- **Scope precedence.** A `@scope:registry=` line of `.npmrc` beats both
  `--registry` and the workflow's `registry` for that scope's packages (an
  npm and pnpm rule). Keep the scope line and `registry` pointing at the same
  registry.
- **Ignored versions (`ignore-versions`).** The restore takes the highest
  stable version from the release tags and the registry. When another tool
  published into the same registry (date-based versions of the form
  `YYYYMM.minor.patch` next to the `x.y.z` semver line), those always sort
  highest: the Release PR would bump from the date-based version and Publish
  Latest would refuse the next semver as older.
  `ignore-versions: '^\d{6}\.'` hides them from the restore, the bump
  base, publish-latest's "older than released" and "BLOCKED: newer on the
  registry" checks, and publish-tag's tag-versus-restored match. The
  manifest's own versions must still be plain `x.y.z`. Without the filter,
  restore-versions warns when it restores such a version. The consumers' own
  tools (Renovate, `npm outdated`, `>=` ranges) still see those versions;
  deprecate or delete them after the first release above them.

## Developing

The self-test workflow runs these on every PR and push to master; locally:

```sh
node --test "scripts/test/*.test.mjs"      # Node 22, no install; a glob, not a directory
docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:1.7.12
pipx run yamllint==1.37.1 --strict .
# every ```yaml block of README.md and examples/release-workflows.md,
# against the real workflow_call inputs and secrets
dir=$(mktemp -d) && node scripts/test/extract-examples.mjs "$dir" \
  && docker run --rm -v "$dir":/repo -w /repo rhysd/actionlint:1.7.12
```

The tests put recording `pnpm` / `npm` shims on `PATH`. The golden test
(`registry-auth.test.mjs`) runs the plain shell form of each credential step
from `scripts/test/fixtures/v1/` next to the script and requires the same
calls.

## License

[MIT](LICENSE)
