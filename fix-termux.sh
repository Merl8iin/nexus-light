#!/bin/sh
# Termux/Android build fixes (run after every npm install):
#  - workerd has no Android build: map android -> linux-arm64 so wrangler loads (never executed for deploy).
#  - esbuild needs its Android binary, which .npmrc's os=linux skips: unpack it by hand.
cd "$(dirname "$0")"
./patch-workerd.sh
v=$(node -p 'require("./node_modules/esbuild/package.json").version')
if [ ! -x node_modules/@esbuild/android-arm64/bin/esbuild ]; then
  t=$(npm pack "@esbuild/android-arm64@$v" --silent) && mkdir -p node_modules/@esbuild/android-arm64 && tar xzf "$t" -C node_modules/@esbuild/android-arm64 --strip-components=1 && rm "$t"
fi
