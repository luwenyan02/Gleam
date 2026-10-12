#!/bin/sh
folder=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sh "$folder/preview-bootstrap.sh" update
result=$?
if [ "$result" -ne 0 ]; then printf '\n按回车关闭此窗口。'; read -r answer; fi
exit "$result"
