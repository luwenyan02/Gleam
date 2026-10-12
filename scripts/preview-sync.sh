#!/bin/sh
# Dedicated preview checkout only. No reset, clean, browser-data writes or push.
set -eu
root=${GLEAM_PREVIEW_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
cd "$root"
branch=preview/orbstack
action=${1:-update}
fail() { printf '%s\n' "$*" >&2; exit 1; }
case "$action" in update|rollback|status) ;; *) fail '用法：sh scripts/preview-sync.sh [update|rollback|status]' ;; esac
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail '此目录不是 Git 检出。'
[ "$(git rev-parse --show-toplevel)" = "$root" ] || fail '请在专用预览检出中运行。'

# Git can replace this very script during an update; run an immutable copy.
if [ "${GLEAM_PREVIEW_SNAPSHOT:-0}" != 1 ]; then
  mkdir -p .tmp/preview-sync
  runner=$(mktemp "$root/.tmp/preview-sync/runner.XXXXXX")
  cp "$0" "$runner"
  trap 'rm -f "$runner"' EXIT
  trap 'exit 130' HUP INT TERM
  GLEAM_PREVIEW_ROOT="$root" GLEAM_PREVIEW_SNAPSHOT=1 sh "$runner" "$action"
  exit
fi

state=$root/.tmp/preview-sync/state
mkdir -p "$state"
if [ "$action" = status ]; then
  git log -1 --format='%h %s'
  printf '分支：%s\n' "$(git branch --show-current)"
  sh scripts/preview-local.sh status
  exit
fi
lock=$(git rev-parse --absolute-git-dir)/gleam-preview-sync.lock
mkdir "$lock" 2>/dev/null || fail '另一次更新正在进行；未改动源码。若上次被强制中断，请确认没有更新进程后再移除 .git/gleam-preview-sync.lock。'
trap 'rmdir "$lock"' EXIT
trap 'exit 130' HUP INT TERM
[ -z "$(git status --porcelain --untracked-files=all)" ] || fail '预览检出有未提交或未跟踪文件，已停止；请保留并处理本地修改后重试。'
current=$(git branch --show-current)
head=$(git rev-parse HEAD)
recovery=$(cat "$state/recovery.branch" 2>/dev/null || true)
if [ "$current" != "$branch" ] && { [ -z "$recovery" ] || [ "$current" != "$recovery" ]; }; then
  fail '当前不是 preview/orbstack 或脚本创建的恢复分支，已停止。'
fi
good=$(cat "$state/last-good.sha" 2>/dev/null || true)
if [ -n "$good" ] && [ "$head" != "$good" ]; then
  fail '检出已在脚本之外切换提交，无法确定对应镜像；已停止。'
fi
context=${GLEAM_DOCKER_CONTEXT:-orbstack}
helper() { sh scripts/preview-local.sh "$@"; }
docker_cmd() { docker --context "$context" "$@"; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$

snapshot() {
  backup=$root/.tmp/preview-sync/backups/$stamp-$(git rev-parse --short HEAD)
  mkdir -p "$backup"
  git archive --format=tar HEAD > "$backup/source.tar"
  gzip "$backup/source.tar"
  tar -tzf "$backup/source.tar.gz" >/dev/null
  git rev-parse HEAD > "$backup/head.txt"
  git update-ref "refs/preview-backups/$stamp" HEAD
  printf '源码备份：%s\n' "$backup"
}
cache_image() {
  old_image=$(helper image-id) || fail '找不到上一版预览镜像，已停止；请先恢复容器或检查 OrbStack。'
  old_ref=gleam-preview:backup-$(printf '%s' "$head" | cut -c1-12)
  docker_cmd image tag "$old_image" "$old_ref"
}
restore() {
  restore_sha=$1
  restore_image=$2
  rejected=$3
  restore_branch=preview-recovery/$stamp
  git switch -q -c "$restore_branch" "$restore_sha" || fail '恢复分支切换失败；源码备份仍保留，请检查本地修改。'
  printf '%s\n' "$restore_branch" > "$state/recovery.branch"
  printf '%s\n' "$rejected" > "$state/rejected.sha"
  printf '%s\n' "$restore_sha" > "$state/last-good.sha"
  printf '%s\n' "$restore_image" > "$state/recovery.image"
  if GLEAM_PREVIEW_IMAGE="$restore_image" helper reload; then
    printf '%s\n' '已恢复上一版源码和镜像；新提交保留在 preview/orbstack。浏览器账本未作改动。'
  else
    fail '已恢复源码，但容器仍未启动；请检查 OrbStack、端口与日志。备份和新提交均保留。'
  fi
}

if [ "$action" = rollback ]; then
  [ "$current" = "$branch" ] || fail '当前已经在恢复分支；等待新预览提交后再更新。'
  previous=$(cat "$state/previous-good.sha" 2>/dev/null || true)
  image=$(cat "$state/previous-good.image" 2>/dev/null || true)
  [ -n "$previous" ] && [ -n "$image" ] || fail '没有可回退的上一版预览。'
  docker_cmd image inspect "$image" >/dev/null || fail '上一版镜像不在本机；保留当前预览，未回退。'
  snapshot
  restore "$previous" "$image" "$head"
  exit
fi

# Fetch a pinned target without altering branches or the running service.
if ! GIT_TERMINAL_PROMPT=0 git fetch --quiet --no-tags origin "refs/heads/$branch" 2> "$state/fetch-error.tmp"; then
  rm -f "$state/fetch-error.tmp"
  fail '拉取失败，源码和运行中的预览未改变。请检查网络、GitHub 私有仓库读取权限和 preview/orbstack 分支。'
fi
rm -f "$state/fetch-error.tmp"
target=$(git rev-parse FETCH_HEAD)
preview_head=$(git rev-parse "refs/heads/$branch")
git merge-base --is-ancestor "$preview_head" "$target" || fail '远端回退、分支分叉或存在本地提交，已停止；未覆盖源码。'
if [ "$current" != "$branch" ] && [ "$target" = "$(cat "$state/rejected.sha")" ]; then
  image=$(cat "$state/recovery.image")
  GLEAM_PREVIEW_IMAGE="$image" helper ensure
  printf '%s\n' '远端暂无新版本，继续使用已恢复的预览。'
  exit
fi

# Refuse a missing or syntactically broken updater before replacing our copy.
for script in scripts/preview-sync.sh scripts/preview-local.sh; do
  candidate=$state/candidate.tmp
  if ! git show "$target:$script" > "$candidate" 2>/dev/null || ! sh -n "$candidate" 2>/dev/null; then
    rm -f "$candidate"
    fail '远端预览脚本缺失或语法无效，已停止；源码和容器未改变。'
  fi
  rm -f "$candidate"
done

mode=ensure
old_ref=
if [ -z "$good" ]; then
  mode=up
elif [ "$head" != "$target" ]; then
  cache_image
  changed=$(git diff --name-only "$head" "$target")
  # A redirected loop preserves mode in POSIX sh; macOS needs no rg/Python.
  printf '%s\n' "$changed" > "$state/changed.tmp"
  while IFS= read -r file; do
    case "$file" in
      app/package.json|app/package-lock.json|app/vendor/*|deploy/preview/Dockerfile|.dockerignore) mode=up ;;
      app/vite.config.ts|app/tsconfig*.json|app/index.html|compose.preview.yaml|scripts/preview-local.sh)
        if [ "$mode" != up ]; then mode=reload; fi ;;
    esac
  done < "$state/changed.tmp"
  rm -f "$state/changed.tmp"
fi
if [ "$head" != "$target" ]; then
  snapshot
  if [ "$current" != "$branch" ]; then git switch -q "$branch"; fi
  git merge --quiet --ff-only "$target"
fi
if ! helper "$mode"; then
  if [ -n "$good" ] && [ -n "$old_ref" ]; then restore "$head" "$old_ref" "$target"; fi
  fail '本次更新未通过启动检查；请查看预览日志。'
fi
image=$(helper image-id) || fail '容器启动后无法读取镜像标识；请检查 OrbStack。'
if [ "$head" != "$target" ] && [ -n "$good" ]; then
  printf '%s\n' "$head" > "$state/previous-good.sha"
  printf '%s\n' "$old_ref" > "$state/previous-good.image"
fi
printf '%s\n' "$target" > "$state/last-good.sha"
printf '%s\n' "$image" > "$state/last-good.image"
rm -f "$state/recovery.branch" "$state/rejected.sha" "$state/recovery.image"
printf '预览已就绪：%.12s · http://localhost:5173/\n' "$target"
