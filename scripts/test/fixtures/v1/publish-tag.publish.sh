# The credential write of the "Registry auth for the publish" step in .github/workflows/publish-tag.yml as a plain
# shell step. Golden reference for scripts/test/registry-auth.test.mjs: with the default inputs,
# registry-auth.mjs must make exactly the calls this makes. Do not edit.
R="${REGISTRY#https:}"; R="${R%/}"
pnpm config set "$R/:_authToken" "$PUBLISH_TOKEN"
