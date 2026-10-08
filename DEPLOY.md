# Deploying Procurement Portal to a VPS for testing

Push to GitHub → GitHub Actions SSHes into the VPS → builds there → rolls the
containers → smoke-tests the result.

```
git push  →  Actions  →  ssh VPS  →  deploy/deploy.sh  →  compose up  →  smoke test
```

Once Part 2–5 are done, day-to-day deploying is just `git push`.

---

## Part 1 — One thing to understand first

**The API does not connect to Postgres the normal way.** `DbService` runs every
single SQL statement by shelling out to `docker exec <container> psql`
(`apps/api/src/db/db.service.ts`). This was a deliberate local-dev workaround,
and the code comments say so.

Three consequences, all of which are already handled in the config in this repo:

| Requirement | Where it's satisfied |
|---|---|
| The API image needs a `docker` CLI | `docker/api.Dockerfile` copies it from `docker:27-cli` |
| The API needs the Docker socket | `docker-compose.vps.yml` mounts `/var/run/docker.sock` |
| Postgres must be named `procurement-portal-db` | `docker-compose.vps.yml` sets `container_name` |

**If the Postgres container ever gets renamed, every page that loads data will
fail while `/health` still returns 200.** That is the failure mode to watch for
during testing.

The clean fix is to rewrite `DbService` to use the `pg` driver (already a
dependency). That is a code change, not a deploy change, so it is deliberately
left out of this guide.

### Ports

| Service | Public URL |
|---|---|
| Web admin | `http://<VPS_IP>:8080` |
| Vendor onboarding | `http://<VPS_IP>:8081` |
| API | `http://<VPS_IP>:8082` |

The API is public because `NEXT_PUBLIC_API_BASE` is read by the **browser** and
inlined into the bundle at build time (`apps/web/lib/api.ts`). The tester's
laptop calls it directly, so it has to be a real public address — and those exact
origins must be allowed through CORS.

---

## Part 2 — Push the code to GitHub

Run from `E:\Procurement Application\procurement-portal`.

**2.1** Git needs to know who you are (it is not configured yet):

```powershell
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"
```

**2.2** Create the repository on github.com first (empty, **no** README — that
avoids a conflicting-initial-commit error). Then:

```powershell
cd "E:\Procurement Application\procurement-portal"
git init -b main
git add -A
git status              # CHECK THIS BEFORE COMMITTING
git commit -m "Procurement portal: initial commit for VPS deployment"
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

> You chose a **public** repo. I audited it: no real credentials, keys, or
> `.env` files are present — only dev defaults like `proc_local`, plus demo seed
> data (vendor names, prices, staff email addresses). Everything like that
> becomes publicly visible and readable in history. If any of it is sensitive,
> switch the repo to private now, before the first push.

---

## Part 3 — One-time VPS setup

SSH into the VPS as a non-root user and run:

**3.1** Install the prerequisites:

```bash
sudo apt update && sudo apt install -y git curl
```

**3.2** Clone the repo:

```bash
git clone https://github.com/<your-username>/<repo-name>.git ~/procurement-portal
cd ~/procurement-portal
```

**3.3** Create the config file (this holds the passwords — keep it out of git):

```bash
cp deploy/env.vps.example deploy/env.vps
nano deploy/env.vps
```

Set these four values:

```bash
VPS_IP=<the server's public IP>

DB_PASSWORD=<strong password>
API_JWT_SECRET=<output of: openssl rand -base64 48>

API_CORS_ORIGINS=http://<VPS_IP>:8080,http://<VPS_IP>:8081
```

Keep `D365_MODE=stub` — the test stack makes no external calls.

**3.4** Allow SSH inbound for GitHub Actions. If the firewall blocks port 22,
allow GitHub's published IP ranges.

**3.5** Give the SSH user permission to run Docker:

```bash
sudo usermod -aG docker "$USER"
newgrp docker
```

Without this the deploy fails with a permission error on `/var/run/docker.sock`.

---

## Part 4 — First deploy

On the VPS:

```bash
cd ~/procurement-portal
./deploy/deploy.sh
```

It builds the three images, starts Postgres, applies the 55 migrations, rolls the
app containers, and waits for each to report healthy. Expect roughly 5–10 minutes
on the first build.

Open `http://<VPS_IP>:8080` and log in with a seeded account.

> Migrations are tracked in a `public.schema_migrations` ledger, so this script
> only applies new files and is safe to re-run. (The laptop script
> `db/scripts/migrate.sh` replays everything and will fail on duplicate seed
> rows — that is why the deploy uses its own runner.)

---

## Part 5 — Automate it on every push

**5.1** Generate a deploy key on your **laptop**:

```powershell
ssh-keygen -t ed25519 -C "github-actions-deploy" -f "$env:USERPROFILE\.ssh\github_actions_deploy"
```

No passphrase, because GitHub Actions has no way to prompt for one.

**5.2** Copy the public key to the VPS and authorize it:

```powershell
Get-Content "$env:USERPROFILE\.ssh\github_actions_deploy.pub" | ssh <vps-user>@<VPS_IP> "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

**5.3** Add four secrets in GitHub — repo → **Settings → Secrets and variables
→ Actions → New repository secret**:

| Name | Value |
|---|---|
| `VPS_HOST` | the VPS IP |
| `VPS_USER` | the SSH user from step 3 |
| `VPS_SSH_KEY` | the **private** key contents from 5.1 |
| `VPS_APP_DIR` | `/home/<vps-user>/procurement-portal` |

**5.4** Push to `main`. The **Deploy to VPS** action runs, and after it finishes,
open the run to see the smoke-test output.

From now on: `git push` is the whole deploy.

---

## Part 6 — Day-to-day

```powershell
git add -A
git commit -m "description of the change"
git push
```

Watch the run in the Actions tab. If it goes red, the failure step prints the
container logs automatically.

To deploy by hand on the VPS (useful when Actions is blocked):

```bash
cd ~/procurement-portal
git pull
./deploy/deploy.sh
```

---

## Troubleshooting

**Every page shows a network error, but `/health` is fine**
→ CORS. The browser's origin is not in `API_CORS_ORIGINS`. Check for a trailing
slash or port mismatch, then `docker compose -f docker-compose.vps.yml --env-file deploy/env.vps up -d api`.

**Pages call `localhost:33001` instead of the VPS address**
→ `NEXT_PUBLIC_API_BASE` was not set at build time. It is inlined into the
bundle, so the images must be rebuilt:

```bash
./deploy/deploy.sh
```

**API logs show `docker: command not found` or a socket permission error**
→ The socket group (step 3.5) or the CLI copy in `docker/api.Dockerfile`. Check
with `docker compose ... logs api`.

**Deploy fails at the migration step**
→ `deploy/migrate.sh` reports which file failed. The ledger is not updated for
it, so the next deploy retries it. Inspect with:

```bash
docker logs --tail 100 procurement-portal-db
```

**Port already in use**
→ Change the `*_PUBLIC_PORT` values in `deploy/env.vps` and update
`API_CORS_ORIGINS` and `NEXT_PUBLIC_API_BASE` to match.

**Roll back to the previous release**

```bash
git log --oneline -5                       # find the good SHA
git checkout <sha> && ./deploy/deploy.sh
```

---

## Security note

This is a **test** deployment:

- No TLS — everything is plain HTTP, including login credentials.
- The API port is open to the internet, and login is the only protection.
- `deploy/env.vps` holds the database password and JWT signing secret in plain
  text on the VPS (600 permissions).

Fine for an internal test box. Before any real use: put it behind a domain with
TLS, close 8082 behind a reverse proxy so the browser calls the API
same-origin, and move the secrets out of the file.