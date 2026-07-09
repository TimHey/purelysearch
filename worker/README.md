# purelysearch-edge

Cloudflare Worker that sits in front of the static GitHub Pages site (the domain
is already proxied through Cloudflare). It:

1. Logs agent/crawler hits to Upstash Redis (namespaced `ps:` keys), off the
   response path. Agents don't run JS, so GA4 can't see them — this can.
2. Serves `GET /api/agent-traffic` with live JSON counters for `/agents.html`.
3. Passes everything else through to the origin unchanged.

## Deploy (one time)

Upstash creds are reused from the Pickrate `.env.local`. These commands pipe the
values straight into Wrangler without printing them:

```sh
cd ~/purelysearch/worker
npx wrangler login
grep '^UPSTASH_REDIS_REST_URL='   ~/pickrate/app/.env.local | cut -d= -f2- | npx wrangler secret put UPSTASH_REDIS_REST_URL
grep '^UPSTASH_REDIS_REST_TOKEN=' ~/pickrate/app/.env.local | cut -d= -f2- | npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
npx wrangler deploy
```

`wrangler deploy` creates the `purelysearch.com/*` route automatically (the zone
is in the same Cloudflare account). After that, `/agents.html` shows live counts.

## Redeploy after code changes

```sh
cd ~/purelysearch/worker && npx wrangler deploy
```

## Keys (Upstash)

- `ps:agents:totals` — hash, agent → all-time hits
- `ps:agents:day:<YYYY-MM-DD>` — hash, agent → hits that day (120d TTL)
- `ps:agents:paths` — hash, path → hits
- `ps:agents:recent` — list, last 200 hits as JSON
