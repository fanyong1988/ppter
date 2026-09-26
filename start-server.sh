#!/bin/sh

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR" || exit 1

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '未检测到 Node.js，请先安装: https://nodejs.org/zh-cn/download'
  exit 1
fi

exec node scripts/start.js
