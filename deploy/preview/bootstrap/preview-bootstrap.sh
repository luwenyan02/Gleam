#!/bin/sh
set -eu
folder=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
checkout=$folder/checkout
action=${1:-update}
branch=preview/orbstack
url=${GLEAM_PREVIEW_GIT_URL:-}
if [ -z "$url" ] && [ -d "$checkout/.git" ]; then
  url=$(git -C "$checkout" config --get gleam.previewOrigin || true)
fi
url=${url:-https://github.com/luwenyan02/Gleam.git}
fail() { printf '%s\n' "$*" >&2; exit 1; }
command -v git >/dev/null || fail '需要 macOS Git（Xcode Command Line Tools）和 OrbStack；无需安装 Node。'
command -v docker >/dev/null || fail '请安装并打开 OrbStack，再双击更新预览。'
lock=$folder/.bootstrap-lock
mkdir "$lock" 2>/dev/null || fail '另一次初始化或更新正在进行，请等待；未覆盖文件。'
temporary=
cleanup() {
  if [ -n "$temporary" ] && [ -d "$temporary" ]; then rm -rf "$temporary"; fi
  rmdir "$lock"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
if [ ! -d "$checkout/.git" ]; then
  [ "$action" = update ] || fail '请先双击“更新拾光预览”完成首次初始化。'
  if [ -e "$checkout" ]; then fail 'checkout 已存在且不是独立 Git 检出，未覆盖；请换一个空目录解压。'; fi
  GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code "$url" "refs/heads/$branch" >/dev/null 2>&1 || fail '无法读取 preview/orbstack。请确认分支已获批准并推送，以及本机 Git 已有此私有仓库的读取权限。'
  temporary=$(mktemp -d "$folder/.checkout.XXXXXX")
  if ! GIT_TERMINAL_PROMPT=0 git clone --quiet --depth 1 --branch "$branch" "$url" "$temporary" 2>/dev/null; then
    fail '首次下载失败，未覆盖本地文件；请检查 GitHub 读取权限和网络后重试。'
  fi
  mv "$temporary" "$checkout"
  temporary=
  git -C "$checkout" config gleam.previewOrigin "$url"
fi
cd "$checkout"
[ "$(git remote get-url origin)" = "$url" ] || fail '专用检出的来源与配置仓库不同，未同步；请检查目录。'
sh scripts/preview-sync.sh "$action"
if [ "${GLEAM_PREVIEW_NO_BROWSER:-0}" != 1 ] && command -v open >/dev/null; then
  open http://localhost:5173/
fi
