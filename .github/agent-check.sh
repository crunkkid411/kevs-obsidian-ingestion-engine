#!/usr/bin/env bash
# agent-check.sh [base-ref]
# The one check every agent push must pass. Exit 0 = green, 1 = red.
# Runs on GitHub (copied into each repo as .github/agent-check.sh) and on Jordan's PC
# (the pre-push hook). A repo can replace it with its own .agent-check.sh at its root.
# base-ref: what the branch is compared to (origin/master). Only changed files are
# syntax-checked; Go is checked as a whole module because one change can break any package.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 1
base="${1:-}"

if [ -f .agent-check.sh ]; then
  echo "agent-check: this repo has its own .agent-check.sh, running that"
  exec bash .agent-check.sh "$base"
fi

if [ -n "$base" ] && git rev-parse -q --verify "$base^{commit}" >/dev/null; then
  mapfile -t changed < <(git diff --name-only --diff-filter=ACMR "$base"...HEAD)
else
  mapfile -t changed < <(git ls-files)
fi

fail=0; ran=0
step() { ran=1; echo "agent-check: $*"; "$@" || { echo "agent-check: FAILED: $*"; fail=1; }; }
pick() { for f in "${changed[@]}"; do [ -f "$f" ] && printf '%s\n' "$f"; done | grep -E "$1"; }
PY=$(command -v python3 || command -v python || true)

# Leftover merge-conflict markers in any changed text file
mapfile -t txt < <(pick '\.(go|py|js|mjs|cjs|ts|tsx|json|md|ps1|bat|cpp|h|hpp|c|cs|rs|toml|ya?ml|html|css|sh)$')
if [ ${#txt[@]} -gt 0 ]; then
  ran=1
  if grep -n -E '^(<<<<<<< |>>>>>>> )' -- "${txt[@]}"; then echo "agent-check: FAILED: merge-conflict markers left in files"; fail=1; fi
fi

# Go: build, vet, test every Go module in the repo (root or subfolders like becky-go/)
if command -v go >/dev/null; then
  while read -r mod; do
    d=$(dirname "$mod")
    echo "agent-check: Go module in $d"
    (cd "$d" && step go build ./... && step go vet ./... && step go test ./...) || fail=1
    ran=1
  done < <(git ls-files 'go.mod' '*/go.mod' | grep -v -E '(^|/)(vendor|testdata|third_party)/')
fi

# Python: every changed file must compile
mapfile -t py < <(pick '\.py$')
if [ ${#py[@]} -gt 0 ] && [ -n "$PY" ]; then
  for f in "${py[@]}"; do step "$PY" -c 'import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8-sig").read(),sys.argv[1])' "$f"; done
fi

# JavaScript: syntax check
mapfile -t js < <(pick '\.(js|mjs|cjs)$')
if [ ${#js[@]} -gt 0 ] && command -v node >/dev/null; then
  for f in "${js[@]}"; do step node --check "$f"; done
fi

# JSON must parse
mapfile -t jsn < <(pick '\.json$' | grep -v -E '(^|/)(tsconfig|jsconfig)[^/]*\.json$|(^|/)\.vscode/')  # those allow comments
if [ ${#jsn[@]} -gt 0 ] && [ -n "$PY" ]; then
  for f in "${jsn[@]}"; do step "$PY" -c 'import json,sys; json.load(open(sys.argv[1],encoding="utf-8-sig"))' "$f"; done
fi

# PowerShell: must parse under Windows PowerShell 5.1 (what a double-clicked .bat uses). Windows only.
mapfile -t ps < <(pick '\.ps1$')
if [ ${#ps[@]} -gt 0 ] && command -v powershell.exe >/dev/null; then
  for f in "${ps[@]}"; do
    step powershell.exe -NoProfile -Command "\$e=\$null;[void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path '$f'),[ref]\$null,[ref]\$e); if(\$e){\$e|ForEach-Object{\$_.ToString()}; exit 1}"
  done
fi

[ $ran -eq 0 ] && echo "agent-check: nothing in this change has an automatic check (C++, C#, docs...)"
[ $fail -eq 0 ] && echo "agent-check: GREEN" || echo "agent-check: RED"
exit $fail
