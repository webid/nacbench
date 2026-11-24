# Self-Hosting NACBench on a Linux VPS (`Nginx` + `Certbot` + `rsync`)

This kit deploys the static NACBench SPA directly to any Debian/Ubuntu VPS running **Nginx**, **Certbot**, and **rsync**, with zero third-party hosting lock-in.

## Target Server Layout
- **SSH Host Alias / User:** `<your-vps-host>` (`<your-vps-user>`)
- **Web Server / TLS:** Nginx (`/etc/nginx/sites-available` → `sites-enabled`) + Certbot (`certbot --nginx`)
- **Webroot:** `/var/www/nacbench` (owned by `<your-vps-user>:www-data`, mode `2755` — zero `sudo` needed for future deploys)

---

## 4-Step Launch Checklist

### Step 1 — Configure DNS at `<your-dns-provider>`
Add DNS records pointing your domain (e.g. `nacbench.thetezos.com`) to your VPS:

| Type | Name | Target | TTL |
| --- | --- | --- | --- |
| `A` | `nacbench` | `<your-ipv4>` | `300` (or Auto) |
| `AAAA` *(optional)* | `nacbench` | `<your-ipv6>` | `300` (or Auto) |

Verify DNS propagation before running Certbot:
```bash
dig +short A nacbench.thetezos.com
# Expected: <your-ipv4>
```

### Step 2 — Run One-Time Server Provisioning (`sudo`)
Copy the two provisioning files to your VPS and run `setup-server.sh` once with `sudo` (keep `-t` so `sudo` gets a TTY for the password prompt):
```bash
ssh <your-vps-host> 'mkdir -p ~/nacbench-vps-setup'
scp deploy/vps/nacbench.thetezos.com.nginx.conf deploy/vps/setup-server.sh <your-vps-host>:~/nacbench-vps-setup/
ssh -t <your-vps-host> 'sudo bash ~/nacbench-vps-setup/setup-server.sh'
```
> If DNS hasn't propagated yet, pass `--skip-certbot` first, then run `ssh -t <your-vps-host> 'sudo certbot --nginx -d nacbench.thetezos.com --redirect'` once `dig +short A nacbench.thetezos.com` returns `<your-ipv4>`.
> Override defaults via env vars if needed: `DOMAIN=nacbench.example.com DEPLOY_USER=<your-vps-user> WEB_ROOT=/var/www/nacbench`.

This one-time script:
1. Creates `/var/www/nacbench` owned by `<your-vps-user>:www-data` (`chmod 2755`).
2. Installs `/etc/nginx/sites-available/nacbench.thetezos.com` and symlinks it into `sites-enabled`.
3. Runs `nginx -t` and reloads Nginx.
4. Obtains and wires the Let's Encrypt TLS certificate via `certbot --nginx -d nacbench.thetezos.com --redirect`.

### Step 3 — Deploy the Built SPA (Zero `sudo` Forever)
From the repository root on your local machine (or set `VPS_HOST=<your-vps-host>` in your git-ignored local `.env`):
```bash
VPS_HOST=<your-vps-host> npm run deploy:vps
```
This builds `apps/web/dist` (`tsc --noEmit && vite build`) and syncs it to `<your-vps-host>:/var/www/nacbench/` via `rsync -avz --delete`.

### Step 4 — Verify Live HTTPS Site & Headers
```bash
curl -sI https://nacbench.thetezos.com | head -n 15
```
Confirm:
- `HTTP/2 200` (and HTTP redirects `301` → HTTPS)
- `cache-control: no-cache` on `/` (`index.html`) and `immutable` on `/assets/*.js`
- `/favicon.svg` returns `HTTP/2 200` with `content-type: image/svg+xml`
- Open **`https://nacbench.thetezos.com`** in your browser and verify all 3 modules load with zero console or CSP errors.
