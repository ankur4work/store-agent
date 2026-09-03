# Deploying StoreAgent

The app now runs as a single container with a mounted volume. This document is
the runbook, and it is also honest about what has and has not been verified.

**Read [What is not verified](#what-is-not-verified) before pointing a real
merchant at this.** The code is tested; the *round trip through Shopify* is not.

---

## 1. Rotate the credentials first

Two live secrets were pasted into a chat transcript during development:

| Secret | Where to rotate |
|---|---|
| `SHOPIFY_API_SECRET` (`shpss_…`) | Partner Dashboard → your app → **API credentials** |
| `OPENAI_API_KEY` (`sk-svcacct-…`) | OpenAI dashboard → **API keys** → revoke, then create |

Both must be rotated before deploying — the current values should be treated as
public. The Shopify secret signs every webhook and OAuth callback; a leaked one
lets anyone forge an order webhook and, with it, your incrementality numbers.

`scripts/check-secrets.mjs` runs as a pre-commit hook so this cannot reach git,
but the transcript is outside its reach.

## 2. Configuration

| Variable | Required | Notes |
|---|:--:|---|
| `OPENAI_API_KEY` | ✅ | Refuses to start without it |
| `STOREAGENT_DB` | ✅ in prod | Must be on the mounted volume. `/data/storeagent.db` in the image |
| `SHOPIFY_API_KEY` | ✅ in prod | Public client id |
| `SHOPIFY_API_SECRET` | ✅ in prod | Rotate first |
| `SHOPIFY_APP_URL` | ✅ in prod | Must be `https://` — enforced |
| `ALLOWED_ORIGINS` | ✅ in prod | Real storefront origins. `*` is rejected |
| `NODE_ENV=production` | ✅ | Turns on the checks below |
| `SHOPIFY_SCOPES` | | Default `read_products` |
| `PORT` | | Default `8787` |
| `MODEL_WORKHORSE` | | Default `gpt-5.6-terra` |

With `NODE_ENV=production` the gateway **refuses to start** rather than run
misconfigured. Each check exists because the mistake is invisible in
development and damaging in production:

- **`ALLOWED_ORIGINS=*`** — any website could drive a merchant's assistant and
  bill them for the tokens.
- **Missing Shopify credentials** — the OAuth routes silently disable, so the
  app looks healthy and no merchant can install. A confusing failure at the
  worst possible moment.
- **Missing `STOREAGENT_DB`** — it would default to the container's ephemeral
  filesystem, which is the exact bug persistence was added to fix.

## 3. Deploy

```bash
docker build -t storeagent .
docker run -d --name storeagent \
  -p 8787:8787 \
  -v storeagent-data:/data \
  -e NODE_ENV=production \
  -e OPENAI_API_KEY=... \
  -e SHOPIFY_API_KEY=... \
  -e SHOPIFY_API_SECRET=... \
  -e SHOPIFY_APP_URL=https://your-domain \
  -e ALLOWED_ORIGINS=https://shop.example.com \
  storeagent
```

**The `-v` is not optional.** Without it the database is ephemeral and every
merchant is logged out on the next deploy.

Any container host works — Fly, Render, Railway, Cloud Run with a volume, or a
VPS. The one requirement below applies everywhere.

### One node only, for now

SQLite allows a single writer, so **run exactly one instance**. On platforms
that autoscale by default, pin `min=max=1`. Two instances on one volume will
produce `SQLITE_BUSY` errors and, worse, two nodes disagreeing about holdout
assignment — which silently corrupts the experiment.

This is the deliberate trade in §5. When one node is no longer enough, the fix
is a Postgres implementation of the same five interfaces.

### Shopify app configuration

In the Partner Dashboard set the redirect URL to:

```
https://your-domain/shopify/callback
```

`SHOPIFY_APP_URL` must match the domain exactly, or the callback fails HMAC.

## 4. Verify the deployment

```bash
curl https://your-domain/healthz
```

```json
{ "ok": true, "mode": "live", "install": "ready", "installedShops": 0 }
```

`install: "ready"` is the field that matters — `"disabled"` means the Shopify
credentials did not load and nobody can install the app.

Then, in order:

1. Install on a **development store** and confirm `installedShops` becomes 1.
2. **Restart the container** and confirm it is *still* 1. This is the test that
   proves persistence works; it is the one thing most worth checking by hand.
3. Ask the widget a question with a price in the answer, and confirm the price
   matches the product page.
4. Place a test order and confirm it appears in the ROI dashboard.

Step 2 is the whole point of this change. Step 4 is the first real test of
attribution, which has never run against a live order.

## 5. Why SQLite, and when to stop using it

Everything was in-memory before this: shop OAuth tokens, settings, sessions,
and the attribution experiment. A restart logged every merchant out and
destroyed the experiment. Sessions are a cache and can be lost; **an experiment
cannot be reconstructed**, which made this the one true blocker to deploying.

SQLite via `node:sqlite` was chosen over Postgres because it needs no server,
adds no dependency, is genuinely durable with WAL, and — unlike a Postgres —
could be tested here and now. The cost is the single-node limit above.

Move to Postgres when any of these is true:

- one node is no longer enough for the traffic
- you want zero-downtime deploys (two nodes must overlap briefly)
- you want managed backups and PITR rather than volume snapshots

`ARCHITECTURE §3` already assumes multiple gateway nodes, so this is a planned
step, not a surprise. Every store interface stays identical — it is a new
implementation of five classes, not a refactor of call sites.

## 6. Backups

```bash
# .backup is safe on a live database; copying the file is not.
docker exec storeagent node -e "
  const {DatabaseSync}=require('node:sqlite');
  new DatabaseSync(process.env.STOREAGENT_DB).exec(\"VACUUM INTO '/data/backup.db'\")"
```

Do not back up by copying `storeagent.db` while the app is running — with WAL
enabled you will capture a torn snapshot missing the `-wal` contents.

What is lost if you lose this file: every merchant's install (they must
reinstall) and the entire attribution history (unrecoverable). Sessions do not
matter.

---

## What is not verified

Being precise, because "deployed" and "working" are different claims:

**Tested and verified live**
- 589 tests, typecheck clean
- Voice: TTS → STT round trip against the live API (`scripts/check-voice.mjs`)
- Grounding: 28-case eval suite
- Persistence: durability across a genuine close-and-reopen

**Built but never run against real Shopify**
- **The OAuth install flow has never completed once.** HMAC, nonce, and token
  exchange are unit-tested against constructed inputs, not against Shopify.
- **No order webhook has ever arrived**, so attribution is untested end to end.
- **The web pixel has never run in a storefront** — and it is the only join for
  holdout-arm orders, so if it is broken the experiment produces nothing.
- **UCP is unverified against a live store.** Phase 0 OPEN-QUESTION #1, the
  `meta.ucp-agent.profile` encoding, is still open.
- **No microphone has ever been used.** Widget capture, VAD, and playback are
  written but unexercised.

The first install on a development store is therefore a real test, and it is
reasonable to expect it to fail the first time. Do that before any merchant
sees this.

**Not built**
- Phase 4 (multi-region, scale) and Phase 5 (launch) — see `ARCHITECTURE §12`.
- No metrics or error tracking beyond stdout logs and `/healthz`.
