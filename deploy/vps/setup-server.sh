#!/usr/bin/env bash
# One-time idempotent server provisioning for NACBench on a Debian/Ubuntu VPS (Nginx + Certbot).
#
# Run ONCE on your VPS with sudo AFTER pointing DNS (A / AAAA) for your domain:
#   sudo bash setup-server.sh
#
# Optional flags / env:
#   --skip-certbot              Install Nginx vhost & webroot only (skip TLS issuance for now)
#   DOMAIN=nacbench.thetezos.com
#   DEPLOY_USER=<your-vps-user> Defaults to $SUDO_USER (or $USER)
#   WEB_ROOT=/var/www/nacbench
#   CERTBOT_EMAIL=you@domain    Pass an email address to Certbot (otherwise Certbot uses existing registration or prompts)
#
# After this one-time setup, /var/www/nacbench is owned by <DEPLOY_USER>:www-data (2755) so all
# future deployments via `VPS_HOST=<your-vps-host> npm run deploy:vps` run over rsync with ZERO sudo.

set -euo pipefail

DOMAIN="${DOMAIN:-nacbench.thetezos.com}"
DEPLOY_USER="${DEPLOY_USER:-${SUDO_USER:-$USER}}"
WEB_GROUP="${WEB_GROUP:-www-data}"
WEB_ROOT="${WEB_ROOT:-/var/www/nacbench}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NGINX_SRC="${SCRIPT_DIR}/nacbench.thetezos.com.nginx.conf"
NGINX_AVAILABLE="/etc/nginx/sites-available/${DOMAIN}"
NGINX_ENABLED="/etc/nginx/sites-enabled/${DOMAIN}"
SKIP_CERTBOT=false

for arg in "$@"; do
  case "$arg" in
    --skip-certbot) SKIP_CERTBOT=true ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: sudo bash setup-server.sh [--skip-certbot]" >&2
      exit 1
      ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  echo "Error: setup-server.sh must be run with sudo (e.g. sudo bash setup-server.sh)." >&2
  exit 1
fi

if [[ ! -f "${NGINX_SRC}" ]]; then
  echo "Error: Nginx config not found at ${NGINX_SRC}." >&2
  echo "Copy both deploy/vps/setup-server.sh and deploy/vps/nacbench.thetezos.com.nginx.conf to the same folder on your VPS." >&2
  exit 1
fi

if ! id -u "${DEPLOY_USER}" >/dev/null 2>&1; then
  echo "Error: deploy user '${DEPLOY_USER}' does not exist on this host." >&2
  exit 1
fi

echo "==> [1/4] Creating webroot ${WEB_ROOT} owned by ${DEPLOY_USER}:${WEB_GROUP} (mode 2755)"
mkdir -p "${WEB_ROOT}"
chown -R "${DEPLOY_USER}:${WEB_GROUP}" "${WEB_ROOT}"
chmod 2755 "${WEB_ROOT}"

echo "==> [2/4] Installing Nginx site config -> ${NGINX_AVAILABLE}"
if [[ -f "${NGINX_AVAILABLE}" ]] && grep -q "managed by Certbot" "${NGINX_AVAILABLE}"; then
  if [[ "${SKIP_CERTBOT}" == "true" ]]; then
    echo "    Existing Certbot-managed HTTPS config detected at ${NGINX_AVAILABLE}; preserving it under --skip-certbot."
  else
    echo "    Existing Certbot-managed config detected at ${NGINX_AVAILABLE}; backing up to ${NGINX_AVAILABLE}.bak before refresh + certbot."
    cp -a "${NGINX_AVAILABLE}" "${NGINX_AVAILABLE}.bak"
    install -m 0644 "${NGINX_SRC}" "${NGINX_AVAILABLE}"
  fi
else
  install -m 0644 "${NGINX_SRC}" "${NGINX_AVAILABLE}"
fi
ln -sfn "${NGINX_AVAILABLE}" "${NGINX_ENABLED}"

echo "==> [3/4] Validating and reloading Nginx"
nginx -t
systemctl reload nginx

if [[ "${SKIP_CERTBOT}" == "true" ]]; then
  echo "==> [4/4] Skipping Certbot (--skip-certbot). Run later:"
  echo "    sudo certbot --nginx -d ${DOMAIN} --redirect"
else
  echo "==> [4/4] Provisioning/verifying TLS certificate via Certbot for ${DOMAIN}"
  if ! command -v certbot >/dev/null 2>&1; then
    echo "Error: certbot is not installed. Install certbot + python3-certbot-nginx and re-run." >&2
    exit 1
  fi
  if [[ -n "${CERTBOT_EMAIL:-}" ]]; then
    certbot --nginx -d "${DOMAIN}" --redirect --non-interactive --agree-tos -m "${CERTBOT_EMAIL}"
  else
    certbot --nginx -d "${DOMAIN}" --redirect
  fi
fi

echo ""
echo "Setup complete for https://${DOMAIN}"
echo "From your local machine, deploy anytime without sudo using:"
echo "  VPS_HOST=<your-vps-host> npm run deploy:vps"
