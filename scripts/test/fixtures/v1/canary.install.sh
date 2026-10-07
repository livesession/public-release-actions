# The credential write of the "Registry auth (user-level)" step in .github/workflows/canary.yml as a plain
# shell step. Golden reference for scripts/test/registry-auth.test.mjs: with the default inputs,
# registry-auth.mjs must make exactly the calls this makes. Do not edit.
R="${REGISTRY#https:}"; R="${R%/}"
if [ "$PM" = "bun" ]; then
  # bun has no `config set`, and does not read pnpm's config. It does
  # read ~/.npmrc, which npm publish reads too.
  printf '%s/:_authToken=%s\n' "$R" "$GITHUB_NPM_TOKEN" >> ~/.npmrc
else
  pnpm config set "$R/:_authToken" "$GITHUB_NPM_TOKEN"
fi
