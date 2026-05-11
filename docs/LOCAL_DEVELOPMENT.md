# Local Development Guide — URIDA Geo Portal

This guide gets a new developer from zero to a fully running local stack
without touching any server, without editing shared code, and without
committing secrets to Git.

---

## Architecture overview

```
Browser (localhost:3000)
  │
  ▼
React dev-server  (CRA / localhost:3000)
  │   proxy: /api/* and /geoserver/*
  ▼
Node/Express backend  (localhost:8060)
  ├── /api/*            → PostgreSQL/PostGIS  (remote shared DB)
  └── /geoserver/*      → GeoServer proxy     (shared GeoServer via backend)
```

GeoServer and the database are **shared remote services** — they do not run
on your laptop. Only the Node backend and the React dev-server run locally.

---

## Terminal to use on Windows

| Terminal | npm works? | Notes |
|----------|-----------|-------|
| **CMD** (`cmd.exe`) | ✅ Always | Safest choice, no setup needed |
| **PowerShell** | ❌ Blocked by default | Run the fix below once |
| **Git Bash / WSL** | ✅ Always | Good alternative |
| **VS Code terminal** | Depends | Switch it to CMD or Git Bash |

**PowerShell one-time fix** (run as Administrator):
```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```
Type `Y`, press Enter, reopen PowerShell. You only need to do this once per machine.

If you don't want to change the policy, just use **CMD** — it has no restriction.

---

## Prerequisites

| Tool | Minimum version | Check |
|------|----------------|-------|
| Node.js | 18 | `node -v` |
| npm | 9 | `npm -v` |
| Git | any | `git --version` |
| SSH key registered on GitHub | — | see step 1 |

---

## Step 1 — Set up GitHub SSH access

The repository uses SSH. You need an SSH key linked to your GitHub account.

```bash
# Check if you already have a key
ls ~/.ssh/id_ed25519.pub    # or id_rsa.pub

# If not, generate one
ssh-keygen -t ed25519 -C "your_email@example.com"

# Copy the public key and add it to GitHub → Settings → SSH keys
cat ~/.ssh/id_ed25519.pub
```

Test it:

```bash
ssh -T git@github.com
# Expected: Hi <username>! You've successfully authenticated...
```

---

## Step 2 — Clone the repository

```bash
git clone git@github.com:webgisprojects-creator/urida-geo-portal.git
cd urida-geo-portal
```

> **Never clone with HTTPS and then try to push with SSH.**
> Use the `git@github.com:` SSH URL shown above from the start.

---

## Step 3 — Install dependencies

```bash
# Install server + client dependencies from the project root
npm run install:all
```

This runs `npm install` in both `server/` and `client/` using the correct
workspace isolation. Do not run `npm install` at the root — it has no
runtime dependencies of its own.

---

## Step 4 — Create your local environment files

These files are gitignored — you create them once, locally. They are never
committed.

### 4a — Client env

```bash
cp client/.env.example client/.env
```

The defaults in `.env.example` are correct for local dev — no edits needed
unless your React app starts on a port other than 3000.

### 4b — Server env

```bash
cp server/.env.example server/.env
```

Then open `server/.env` and fill in the real values (ask the team lead):

| Key | What to put |
|-----|-------------|
| `DB_HOST` | IP/hostname of the shared dev PostgreSQL server |
| `DB_USER` | Developer DB user (e.g. `nv_allnndb_dev`) |
| `DB_PASS` | Password for that user |
| `DB_NAME` | Database name (e.g. `nv_allnndb`) |
| `GEOSERVER_PROXY_TARGET` | URL of the shared GeoServer (e.g. `https://<ip>/geoserver`) |
| `JWT_SECRET` | Any long random string — generate with `openssl rand -hex 64` |
| `CORS_ORIGINS` | Keep the defaults — covers all local ports |

> **Security rule:** Never put the production DB password or production
> JWT_SECRET in your local `server/.env`. Ask the team lead for a developer
> credential set with read/write access only to what you need.

---

## Step 5 — Run the stack

Open **two terminals** at the project root.

**Terminal 1 — backend:**

```bash
npm run dev:server
```

Expected output:
```
✅ Server running on port 8060
✅ Connected to PostgreSQL
```

**Terminal 2 — frontend:**

```bash
npm run dev:client
```

Expected output:
```
Compiled successfully!
Local: http://localhost:3000
```

Open `http://localhost:3000` in your browser and log in.

---

## Step 6 — Verify everything works

Run these health checks from a third terminal:

```bash
# DB connection
curl -s http://localhost:8060/api/test-db

# Home summary
curl -s -o /dev/null -w "HOME SUMMARY: %{http_code}\n" http://localhost:8060/api/home/summary

# GeoServer WMS proxy
curl -s -o /dev/null -w "WMS: %{http_code}\n" \
  "http://localhost:8060/geoserver/ows?service=WMS&version=1.1.1&request=GetCapabilities"

# Login API
curl -s -X POST http://localhost:8060/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
```

All should return `200` or a JSON success response.

---

## Common errors and fixes

### "Invalid Host header" on `localhost:3000`

**Cause:** `DANGEROUSLY_DISABLE_HOST_CHECK` is missing from `client/.env`.

**Fix:** Make sure `client/.env` contains:
```
HOST=localhost
DANGEROUSLY_DISABLE_HOST_CHECK=true
```

Then restart the React dev-server.

---

### Login returns 500 / "Not allowed by CORS"

**Cause:** The browser's `Origin` header is not in the backend's allowed list.

**How to diagnose:**
1. Open DevTools → Network → click the failed `login` request
2. Look at **Request Headers → Origin**
3. Note the exact value (e.g. `http://192.168.1.5:3000`)

**Fix:** Add that exact origin to `CORS_ORIGINS` in `server/.env`, then
restart the backend (`Ctrl+C` → `npm run dev:server`). Do not edit
`server/src/app.js` for a local fix — keep it in `.env`.

---

### "Cannot find package 'dotenv'" or similar module errors

**Cause:** A package was installed in the wrong workspace.

**Fix:**
```bash
# Remove stale root node_modules and reinstall properly
rm -rf node_modules
npm run install:all
```

---

### DB connection error (`ECONNREFUSED` or auth failure)

**Cause:** Wrong `DB_HOST`, `DB_USER`, or `DB_PASS` in `server/.env`.

**Fix:** Re-check your `server/.env` values with the team lead. Make sure
the developer DB user exists and has the necessary grants:

```sql
GRANT USAGE ON SCHEMA public TO nv_allnndb_dev;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nv_allnndb_dev;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nv_allnndb_dev;
```

---

## Git workflow for developers

```bash
# Start from latest main
git checkout main
git pull origin main

# Create a feature branch — NEVER commit directly to main
git checkout -b feature/your-feature-name

# Make your changes, then check what will be staged
git status -sb

# Stage specific files only — never use "git add ."
git add server/src/routes/myRoute.js

# Commit
git commit -m "feat: add myRoute endpoint"

# Push and open a PR
git push -u origin feature/your-feature-name
```

### Hard rules

- ❌ Never push directly to `main`
- ❌ Never commit `client/.env` or `server/.env`
- ❌ Never commit `node_modules/`
- ❌ Never SSH into the production/pre-production server to fix a local issue
- ✅ All changes go through a PR and must pass CI before merge

---

## Project structure quick reference

```
urida-geo-portal/
├── client/              React 19 SPA (Create React App)
│   ├── .env             Local only — gitignored. Copy from .env.example.
│   ├── .env.example     Template — committed to Git.
│   └── src/
├── server/              Node.js + Express backend (port 8060)
│   ├── .env             Local only — gitignored. Copy from .env.example.
│   ├── .env.example     Template — committed to Git.
│   └── src/
├── deploy/
│   └── ecosystem.config.js   PM2 config for pre-production/production server
├── docs/                Developer documentation
└── .github/workflows/   GitHub Actions CI
```

---

## Useful commands

| Command | What it does |
|---------|-------------|
| `npm run install:all` | Install server + client dependencies |
| `npm run dev:server` | Start backend in watch mode (nodemon) |
| `npm run dev:client` | Start React dev-server |
| `npm run build:client` | Build React for production |
| `npm run pm2:start` | Start backend with PM2 (server only) |
| `npm run pm2:logs` | Tail PM2 logs |
