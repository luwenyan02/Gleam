#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"
case "${1:-up}" in
  up)
    docker --context orbstack compose -f compose.preview.yaml up -d --build --force-recreate --wait --wait-timeout 120
    printf '%s\n' '拾光预览：http://localhost:5173/（源码修改自动更新）'
    ;;
  status) docker --context orbstack compose -f compose.preview.yaml ps ;;
  logs) docker --context orbstack compose -f compose.preview.yaml logs --tail 60 web ;;
  stop) docker --context orbstack compose -f compose.preview.yaml stop web ;;
  *) printf '%s\n' '用法：sh scripts/preview-local.sh [up|status|logs|stop]' >&2; exit 2 ;;
esac
