#!/bin/sh
# Remote Agent bootstrap probe. Runs on a remote server BEFORE the helper
# exists; reports which required tools are present. Always exits 0 and prints
# exactly one JSON line on stdout.
p=false
t=false
g=false
command -v python3 >/dev/null 2>&1 && p=true
command -v tmux >/dev/null 2>&1 && t=true
command -v git >/dev/null 2>&1 && g=true
printf '{"python3":%s,"tmux":%s,"git":%s}\n' "$p" "$t" "$g"
exit 0
