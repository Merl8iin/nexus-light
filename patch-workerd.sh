#!/bin/sh
# Termux/Android: workerd has no Android build. Map android to linux-arm64 so wrangler loads;
# deploy and `dev --remote` never run the binary.
f="$(dirname "$0")/node_modules/workerd/lib/main.js"
grep -q '"android arm64 LE"' "$f" || sed -i 's/  "linux arm64 LE": "@cloudflare\/workerd-linux-arm64",/&\n  "android arm64 LE": "@cloudflare\/workerd-linux-arm64",/' "$f"
