#!/usr/bin/env bash
# Zero-sudo static deployment of NACBench to your VPS (/var/www/nacbench).
#
# Usage:
#   VPS_HOST=<your-vps-host> npm run deploy:vps
#   VPS_HOST=<your-vps-host> VPS_PATH=/var/www/nacbench bash scripts/deploy-vps.sh
#
# Tip: You can also set VPS_HOST=<your-vps-host> in your local git-ignored .env or .env.previewnet.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/apps/web/dist"

# Helper: read a single key from local git-ignored .env / .env.previewnet if unset in shell
read_env_fallback() {
  local key="$1"
  local file line val
  for file in "${ROOT_DIR}/.env" "${ROOT_DIR}/.env.previewnet"; do
    [[ -f "${file}" ]] || continue
    line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "${file}" | tail -n 1 || true)"
    if [[ -n "${line}" ]]; then
      val="${line#*=}"
      val="${val%%#*}"
      val="${val%\"}"
      val="${val#\"}"
      val="${val%\'}"
      val="${val#\'}"
      val="$(printf '%s' "${val}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
      if [[ -n "${val}" ]]; then
        printf '%s' "${val}"
        return 0
      fi
    fi
  done
  return 0
}

VPS_HOST="${VPS_HOST:-$(read_env_fallback VPS_HOST)}"
VPS_PATH="${VPS_PATH:-$(read_env_fallback VPS_PATH)}"
VPS_PATH="${VPS_PATH:-/var/www/nacbench}"

if [[ -z "${VPS_HOST}" ]]; then
  echo "Error: VPS_HOST is not set." >&2
  echo "Usage: VPS_HOST=<your-vps-host> npm run deploy:vps" >&2
  echo "   or: add VPS_HOST=<your-vps-host> to your local git-ignored .env file." >&2
  exit 1
fi

echo "==> [1/3] Building NACBench production SPA (npm run web:build)"
npm --prefix "${ROOT_DIR}" run web:build

echo "==> [2/3] Verifying build output (${DIST_DIR}/index.html)"
if [[ ! -f "${DIST_DIR}/index.html" ]]; then
  echo "Error: ${DIST_DIR}/index.html not found after build." >&2
  exit 1
fi

echo "==> [3/3] Syncing static bundle to ${VPS_HOST}:${VPS_PATH}/ (zero sudo)"
rsync -avz --delete --chmod=Du=rwx,Dg=rx,Do=rx,Fu=rw,Fg=r,Fo=r \
  "${DIST_DIR}/" \
  "${VPS_HOST}:${VPS_PATH}/"

echo ""
echo "Deploy complete -> https://nacbench.thetezos.com"
