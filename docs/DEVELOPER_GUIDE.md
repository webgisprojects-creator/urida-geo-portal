# Developer Guide — URIDA Geo Portal
### For developers new to Git and this project

This guide takes you from zero to a working local setup, and explains exactly how to write code, test it, and submit it for review — step by step.

---

## Part 1 — One-time setup on your computer

You only do this once per machine, ever.

### 1.1 Install required software

| Software | Download link | Check it's installed |
|----------|--------------|---------------------|
| Node.js 18 or higher | https://nodejs.org (LTS version) | `node -v` |
| Git | https://git-scm.com | `git --version` |
| VS Code (recommended) | https://code.visualstudio.com | — |

Open **Command Prompt** (CMD) to run all commands in this guide.
To open CMD: press `Win + R`, type `cmd`, press Enter.

> **Important:** Use CMD, not PowerShell. PowerShell has restrictions that break some commands.

---

### 1.2 Tell Git who you are

Open CMD and run these two commands. Replace with your real name and email:

```cmd
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"
```

This name and email appear on every commit you make. Do this once — it saves to your machine permanently.

---

### 1.3 Set up your SSH key for GitHub

GitHub uses SSH keys to know who you are when you push code. Think of it like a digital ID card.

**Step A — Check if you already have a key:**
```cmd
type %USERPROFILE%\.ssh\id_ed25519.pub
```
If it shows a line starting with `ssh-ed25519`, skip to Step C.

**Step B — Generate a new key (if you don't have one):**
```cmd
ssh-keygen -t ed25519 -C "your.email@example.com"
```
Press Enter three times (accept all defaults, no passphrase needed).

**Step C — Copy your public key:**
```cmd
type %USERPROFILE%\.ssh\id_ed25519.pub
```
Select and copy the entire output line.

**Step D — Add it to GitHub:**
1. Go to https://github.com/settings/keys
2. Click **New SSH key**
3. Title: your computer name (e.g. "My Work Laptop")
4. Key: paste the line you copied
5. Click **Add SSH key**

**Step E — Test it:**
```cmd
ssh -T git@github.com
```
Expected response: `Hi <your-username>! You've successfully authenticated`

---

### 1.4 Get access to the repository

Ask the team lead (Khateeb) to add you as a collaborator on GitHub. You will receive an email invitation — accept it.

---

### 1.5 Clone the repository

This downloads the project to your computer. Do this once:

```cmd
cd C:\
mkdir projects
cd projects
git clone git@github.com:webgisprojects-creator/urida-geo-portal.git
cd urida-geo-portal
```

Your project is now at `C:\projects\urida-geo-portal`.

---

### 1.6 Install project dependencies

```cmd
npm run install:all
```

This installs everything the project needs. It takes a few minutes the first time.

---

### 1.7 Create your environment files

These files tell the app how to connect to the database and other services. They are never committed to GitHub — you create them once on your machine.

**Frontend env file:**
```cmd
copy client\.env.example client\.env
```
No edits needed — the defaults work for local development.

**Backend env file:**
```cmd
copy server\.env.example server\.env
```

Now open `server\.env` in any text editor and fill in these values (ask the team lead):

```
DB_HOST=<ask team lead>
DB_USER=<ask team lead>
DB_PASS=<ask team lead>
DB_NAME=<ask team lead>
GEOSERVER_PROXY_TARGET=<ask team lead>
JWT_SECRET=<generate one — see below>
```

**Generate your JWT_SECRET** (run this in CMD, copy the output into the file):
```cmd
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

> **Rule:** Never send your `server\.env` file to anyone. Never put it in a zip or email. Never commit it to GitHub. It stays on your machine only.

---

## Part 2 — Running the project locally

You do this every time you start working.

### 2.1 Open two CMD windows

You need two separate CMD windows open at the same time.

**CMD Window 1 — Start the backend:**
```cmd
cd C:\projects\urida-geo-portal
npm run dev:server
```

Wait until you see:
```
✅ Server running on port 8060
✅ Connected to PostgreSQL
```

**CMD Window 2 — Start the frontend:**
```cmd
cd C:\projects\urida-geo-portal
npm run dev:client
```

Wait until you see:
```
Compiled successfully!
http://localhost:3000
```

### 2.2 Open in browser

Go to: **http://localhost:3000**

Log in with the credentials given to you by the team lead.

### 2.3 Stop the servers

In each CMD window, press **Ctrl + C** to stop.

---

## Part 3 — Daily workflow (how to make changes)

This is the process every time you work on something. Follow it exactly.

### The golden rules

- ✅ Always work on your own branch — never on `main`
- ✅ Pull latest code before starting any new work
- ✅ Commit small, focused changes with clear messages
- ❌ Never commit `client\.env` or `server\.env`
- ❌ Never push directly to `main`
- ❌ Never work on the same branch as someone else unless agreed

---

### Step 1 — Get the latest code before starting

Every time you sit down to work, do this first:

```cmd
cd C:\projects\urida-geo-portal
git checkout main
git pull origin main
```

This makes sure you're working from the latest version.

---

### Step 2 — Create your own branch

A branch is your own private workspace. Name it after what you're working on:

```cmd
git checkout -b feature/your-feature-name
```

**Branch naming examples:**
- `feature/add-ward-filter`
- `fix/login-button-alignment`
- `feature/agra-road-layer`

> Think of a branch like a separate copy of the code that only you are working on. Your changes don't affect anyone else until you submit them for review.

---

### Step 3 — Make your changes

Open the project in VS Code:
```cmd
code .
```

Make your changes to the files. Test them locally at http://localhost:3000.

---

### Step 4 — Check what you changed

Before committing, always see exactly what changed:

```cmd
git status
```

This shows which files you modified. Look through the list carefully. You should NOT see `client\.env` or `server\.env` — if you do, stop and ask the team lead.

To see the actual changes inside a file:
```cmd
git diff
```

---

### Step 5 — Save your changes (commit)

Add only the files you intentionally changed:

```cmd
git add server/src/routes/myFile.js
git add client/src/components/MyComponent.jsx
```

> **Do not use `git add .`** — it adds everything including files you didn't mean to commit. Always add specific files.

Then commit with a clear message describing what you did:

```cmd
git commit -m "feat: add ward filter to road network query"
```

**Commit message format:**
- `feat: add ...` — new feature
- `fix: correct ...` — bug fix
- `chore: update ...` — maintenance, no new feature
- `docs: update ...` — documentation only

---

### Step 6 — Push your branch to GitHub

```cmd
git push -u origin feature/your-feature-name
```

The first time you push a branch you need `-u origin`. After that, just `git push` is enough.

---

### Step 7 — Open a Pull Request (PR)

A Pull Request is how you ask the team lead to review and merge your code.

```cmd
gh pr create --title "feat: add ward filter to road network query" --body "Added ward number filter to the road network query panel. Tested locally on Agra and Kanpur." --base main
```

Or go to GitHub in your browser — it will show a banner saying "Compare & pull request" after you push.

---

### Step 8 — Wait for review

The team lead will review your code. Two things can happen:

- ✅ **Approved and merged** — your code is live on the server automatically
- 💬 **Changes requested** — the team lead left comments. Fix them on the same branch, commit, and push again. The PR updates automatically.

---

### Step 9 — After your PR is merged, clean up

```cmd
git checkout main
git pull origin main
git branch -D feature/your-feature-name
```

This deletes your local branch and gets you back to the latest main, ready to start the next task.

---

## Part 4 — Common errors and how to fix them

### "Server not reachable" on login page

**Cause:** The backend is not running.
**Fix:** Open CMD Window 1 and run `npm run dev:server`. Wait for the ✅ messages.

---

### "Cannot find module" or "npm ERR!" when starting server

**Cause:** Dependencies not installed.
**Fix:**
```cmd
npm run install:all
```

---

### "Please commit your changes or stash them" when switching branches

**Cause:** You have unsaved changes and are trying to switch branches.
**Fix — Option A** (save changes temporarily):
```cmd
git stash
git checkout main
git stash pop
```
**Fix — Option B** (discard changes you don't need):
```cmd
git checkout -- .
```

---

### "Your branch is behind origin/main"

**Cause:** Someone merged new code to main while you were working.
**Fix:**
```cmd
git checkout main
git pull origin main
git checkout your-branch-name
git merge main
```
If there are conflicts, VS Code will highlight them. Fix them, then:
```cmd
git add .
git commit -m "merge: sync with latest main"
```

---

### "fatal: not a git repository"

**Cause:** You're running git commands in the wrong folder.
**Fix:**
```cmd
cd C:\projects\urida-geo-portal
```

---

### Login shows CORS error in backend terminal

**Cause:** Rare — usually means you're accessing the app via a URL other than `localhost:3000`.
**Fix:** Always open http://localhost:3000 in your browser, not the IP address or any other URL.

---

## Part 5 — Quick reference card

Print this and keep it at your desk.

```
DAILY START
-----------
cd C:\projects\urida-geo-portal
git checkout main
git pull origin main
git checkout -b feature/my-task
npm run dev:server        (CMD window 1)
npm run dev:client        (CMD window 2)
Open: http://localhost:3000


SAVE WORK
---------
git status               (check what changed)
git add specific-file    (add only your files)
git commit -m "feat: ..."
git push -u origin feature/my-task


SUBMIT FOR REVIEW
-----------------
gh pr create --title "..." --body "..." --base main


AFTER PR IS MERGED
------------------
git checkout main
git pull origin main
git branch -D feature/my-task


NEVER DO
--------
git add .
git push origin main
commit client\.env or server\.env
```

---

## Part 6 — Getting help

If something is broken and you can't fix it:

1. Do **not** touch the server or production environment
2. Take a screenshot of the error
3. Run `git status` and screenshot that too
4. Send both to the team lead

If you accidentally committed a `.env` file:
1. Stop immediately
2. Do NOT push
3. Contact the team lead right away
