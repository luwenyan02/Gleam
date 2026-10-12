#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"
context=${GLEAM_DOCKER_CONTEXT:-orbstack}
compose() {
  # Compose's explicit environment list otherwise masks env_file keys when a
  # double-clicked Terminal has no corresponding variable in its environment.
  if [ -n "${GLEAM_PREVIEW_COMPOSE_EXTRA:-}" ]; then
    set -- -f compose.preview.yaml -f "$GLEAM_PREVIEW_COMPOSE_EXTRA" "$@"
  else
    set -- -f compose.preview.yaml "$@"
  fi
  if [ -f app/.env.local ]; then set -- --env-file app/.env.local "$@"; fi
  docker --context "$context" compose "$@"
}
case "${1:-up}" in
  up)
    compose up -d --build --force-recreate --wait --wait-timeout 120
    ;;
  ensure) compose up -d --no-build --wait --wait-timeout 120 ;;
  reload) compose up -d --no-build --force-recreate --wait --wait-timeout 120 ;;
  image-id)
    container=$(compose ps --all -q web)
    [ -n "$container" ] || exit 1
    docker --context "$context" inspect --format '{{.Image}}' "$container"
    exit
    ;;
  status) compose ps; exit ;;
  logs) compose logs --tail 60 web; exit ;;
  stop) compose stop web; exit ;;
  *) printf '%s\n' '用法：sh scripts/preview-local.sh [up|ensure|reload|image-id|status|logs|stop]' >&2; exit 2 ;;
esac
printf '%s\n' '拾光预览：http://localhost:5173/（源码修改自动更新）'
