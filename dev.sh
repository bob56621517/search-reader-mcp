#!/usr/bin/env bash
# 开发容器内执行:首次构建 + tsc --watch 编译 + node --watch 热重载
# 用法(compose dev service 的 command,或容器内手动执行):bash dev.sh
set -e
cd /app/extension

echo "[dev] 首次构建..."
/app/node_modules/.bin/tsc -p tsconfig.json

echo "[dev] tsc --watch + node --watch 启动..."
/app/node_modules/.bin/tsc --watch --preserveWatchOutput &
TSC_PID=$!
trap 'kill "$TSC_PID" 2>/dev/null || true' EXIT

exec node --watch dist/index.js
