# The credential write of the "Registry auth for the publish" step in .github/workflows/canary.yml as a plain
# shell step. Golden reference for scripts/test/registry-auth.test.mjs: with the default inputs,
# registry-auth.mjs must make exactly the calls this makes. Do not edit.
R="${REGISTRY#https:}"; R="${R%/}"
if [ "$PM" = "bun" ]; then
  printf '%s/:_authToken=%s\n' "$R" "$PUBLISH_TOKEN" >> ~/.npmrc  # a later line wins
else
  pnpm config set "$R/:_authToken" "$PUBLISH_TOKEN"
fi
