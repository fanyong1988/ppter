#!/bin/zsh

SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR" || exit 1

if ! command -v node >/dev/null 2>&1; then
  printf '未检测到 Node.js，正在打开安装页面...\n'
  open 'https://nodejs.org/zh-cn/download'
  read '?安装完成后重新双击本文件。按回车关闭...'
  exit 1
fi

node scripts/start.js
EXIT_CODE="$?"
if [ "$EXIT_CODE" -ne 0 ]; then
  read '?启动失败。按回车关闭...'
fi
exit "$EXIT_CODE"
