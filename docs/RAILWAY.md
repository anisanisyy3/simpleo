# Put Simple Cook online with Railway

This project is now **one server** that does everything: it serves the website AND runs the real accounts, real-time messages, stories, food map and camera scanner. It needs **no npm packages** (so the build cannot fail on installs) and **no Supabase** (the old Supabase files are still there if you ever want them).

```
browser  <──https──>  Railway  ─  server/index.js  ─┬─ the website (index.html, *.js, style.css)
                                                    ├─ /api/...   accounts, posts, likes, comments, messages, map
                                                    ├─ /api/events   live messages (Server-Sent Events)
                                                    ├─ /api/ai/...   camera scanner (your AI key stays on the server)
                                                    └─ DATA_DIR (a Volume): simplecook.db + uploaded photos/voice/video
```

## Before you start (2 minutes)

1. A free **GitHub** account and a **Railway** account (sign in to Railway with GitHub; no credit card is needed for Railway's free trial).
2. Unzip this project on your computer.

## Step 1: put the project on GitHub

1. github.com → **New repository** → name it `simple-cook` → **Create**.
2. On the new repo page click **uploading an existing file**, drag **all the files and folders from inside the unzipped folder** (not the folder itself), then **Commit changes**.
   - `index.html` and `package.json` must be at the top level of the repo, not inside another folder.

## Step 2: create the Railway service

1. railway.com → **New Project** → **Deploy from GitHub repo** → pick `simple-cook`.
2. Wait for the build (about 1 minute). It runs `npm start` by itself (`railway.json` already says so).

## Step 3: give it a public address

1. Click the service → **Settings** → **Networking** → **Generate Domain**.
2. Open the address. You should see Simple Cook. Add `/health` to the address: you must see `{"ok":true}`.

## Step 4: attach a Volume (IMPORTANT: this is where accounts and messages are stored)

Without a Volume, every redeploy **erases all accounts, messages and uploads**.

1. In your project, press **Ctrl+K** (or right-click the canvas) → **Volume** → attach it to the service.
2. Set the mount path to `/data`.
3. Railway then sets `RAILWAY_VOLUME_MOUNT_PATH` and the server uses it automatically. The server logs a warning if it runs in production without one.

> Railway's docs say that volumes of **trial** accounts are deleted 30 days after the trial credit ends, unless you upgrade to a paid plan. If the site becomes real, upgrade (Hobby is about $5/month) so your members' data is kept.

## Step 5: variables (Service → **Variables**)

| Variable | Needed? | What it does |
|---|---|---|
| `NODE_ENV` = `production` | yes | production mode |
| `ANTHROPIC_API_KEY` | for the camera AI | without it the camera still opens, but analysing says "not switched on for this site yet" |
| `SCAN_MODEL` or `VISION_MODEL` | optional | model name; default `claude-haiku-5-5` |
| `VISION_TIMEOUT_MS` | optional | seconds to wait for the AI before showing "took too long" (default 45000) |
| `SCAN_DAILY_LIMIT` | optional | photos per member per day (default 20; failed analyses are not counted) |
| `VISION_PROVIDER`, `VISION_BASE_URL`, `VISION_API_KEY` | only to use a different AI | see "Choosing the AI provider" below |
| `FDC_API_KEY` | for nutrition numbers | free key from api.data.gov |
| `RESEND_API_KEY` (+ `MAIL_FROM`) | for "Forgot password" | without it, the page honestly says reset is not set up |
| `MAP_STYLE_URL` | recommended before a big launch | e.g. a MapTiler style URL. The default OpenStreetMap tiles are only for light use |
| `PLACES_AUTO_APPROVE` = `0` | optional | new food places wait for you instead of appearing immediately |

Change a variable → Railway redeploys automatically.

## Choosing the AI provider (camera scanners)

The scanners talk to the AI only through `server/vision.js`, so the provider can be changed with variables, no code edits.

- **Default: Anthropic.** Set `ANTHROPIC_API_KEY` (already supported before). What was checked on 17 Nov 2026 from Anthropic's published pages: Algeria is on the list of countries where the commercial API is offered (Supported Regions Policy, effective 12 Nov 2026); the Commercial Terms allow using the API to power your own product for your own users; the "18+" rule is in the *Consumer* terms for Claude.ai, not for API-based products. What this does NOT settle: Anthropic's policy lets products serve under-18s only if the product adds extra safeguards and tells users they are talking to AI (see Anthropic's "Guidelines for Organizations Serving Minors"), and Simple Cook has no age gate at signup. Decide who your members are and read the Commercial Terms and Usage Policy yourself before launch. API use is pay-as-you-go: a key is not a free unlimited service, so set a spending limit in the Anthropic Console.
- **Another provider or a self-hosted model:** set `VISION_PROVIDER=openai-compatible`, `VISION_BASE_URL` (ending in `/v1`), `VISION_MODEL` and, if needed, `VISION_API_KEY`. Nobody's terms were checked for this option: you must check the provider's licence, age rules, region rules and pricing yourself.
- **Google Gemini (added at the owner's request):** set `VISION_PROVIDER=gemini`, `VISION_MODEL` (a short model id from Google AI Studio, no spaces) and `VISION_API_KEY`. This uses Google's native API and works with the newer `AQ.` keys. Google's terms (age rules, region, whether free-tier photos may be used to improve their products) were NOT checked; check them before launch.

## First live check (2 minutes, do this once after deploying)

The automated tests use a stand-in provider, so they cannot prove that a real provider recognises food. After you add the key: open `/#/scan`, upload 2 real photos of ingredients, press Analyse; then open `/#/food` and upload a real meal photo. In Railway > Deployments > Logs you should see `[vision] provider=anthropic model=...` at start-up. If analysing shows "refused this site's access key", the key or the provider setting is wrong; "model is not available" means the model name is wrong.

## What the scanner error messages mean

| Message shown to the member | Cause | What you do |
|---|---|---|
| "not switched on for this site yet" | no key / incomplete provider variables | add the variables, redeploy |
| "refused this site's access key" | provider rejected the key (401/403) | create a new key, update the variable |
| "model ... is not available" | wrong model name (404) | fix `SCAN_MODEL` / `VISION_MODEL` |
| "AI service is busy" | provider rate limit or credit exhausted (429) | wait, or check your provider billing |
| "took too long" | no answer within `VISION_TIMEOUT_MS` | retry; raise the value if photos are large |
| "could not be reached" | network problem or wrong `VISION_BASE_URL` | check the URL |
| "sent back something we could not read" / "empty answer" | provider answered with nothing usable | retry; if constant, try another model |

## Step 6: test it with TWO browsers (this is the proof it is real)

1. Browser 1: create the account `alice`. Browser 2 (or a private window): create `bob`.
2. As alice: open `#/profile/bob` → **Messages** → send "hello". Bob's browser shows it **instantly** and the Messages badge lights up.
3. Open **Food map**, add a place: the other browser sees it after opening the map.
4. Open **Scan** on your phone (the site is https, so the camera is allowed).

## Moderation

Reports from users are saved in the database. From the Railway service open the **Shell**, then:

```
node server/admin.js reports
node server/admin.js places pending
node server/admin.js delete-post recipe:p123abc
node server/admin.js delete-user someusername
```

## Updating the site

Change files on GitHub → Railway redeploys. The Volume keeps all data.

## What is real and what is not (honest list)

- Real: accounts (passwords hashed with scrypt, HttpOnly cookie), likes/saves/follows/comments/points shared by everyone, uploads, private chat media (only members can open it), live messages/typing/read receipts, stories (24 h), food places and reviews, camera upload to the AI.
- The 37 + 71 recipes, reels and videos that ship with the site are built-in content. Their starting like numbers are the demo numbers from `data.js`; real activity is added on top.
- Not built: email verification at signup, account deletion button (use `delete-user` above), web admin page, push notifications when the site is closed, a database other than SQLite (one server instance only; fine for thousands of members, not for millions).
- Follower-only stories hide the story from the app, but the photo URL itself is public (like any public file link).

## Running it on your own computer

```
node server/index.js          # then open http://localhost:3000
node tests/scan-test.js       # 79 scanner server checks (mock AI, no key needed)
python3 tests/scan-e2e.py     # 42 scanner browser checks (needs Playwright + Chromium)
```
Needs Node 22.13 or newer.
