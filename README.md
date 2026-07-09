# purelysearch.com

Live front door for **PurelySearch** — a free personalized daily brief by text and
email (local news, sports, stocks, weather, home reminders). It's the first property
of the Media Project.

## ⚠️ Status: transitional — converging into `machine`
This static GitHub Pages site is the *current* live site, but the real product runs
on **`machine`** (Next.js on Railway) in the `media-project` repo, which renders
PurelySearch as its `yourbrief` tenant with real signup / consent / SMS. This repo
is being folded into machine and **retired once purelysearch.com's DNS cuts over
from GitHub Pages to Railway** — gated on Twilio toll-free approval.

- **Full plan + runbook:** `~/media-project/purelysearch-migration.md` (Phase 3).
- **Do NOT flip DNS until Twilio approves** — `sms.html` is the opt-in proof URL under review.
- A daily launchd watcher (`com.timhey.twilio-tfv-check`) emails Tim when Twilio flips.

## This repo
- Static HTML, no build step. Edit, push to `main`, GitHub Pages deploys (`CNAME`).
- Pages: `index.html` (daily-brief opt-in landing), `sms.html` (Twilio opt-in proof),
  `terms.html`, `privacy.html`, `consulting.html` (archived old consulting storefront, noindex).
- SEO/discovery: `robots.txt`, `sitemap.xml`, `llms.txt`, `.well-known/ai-catalog.json`
  (ARD) + `security.txt`, GA4 `G-YLECP7DERT`. `.nojekyll` is required so Pages serves `.well-known`.
- Domain: DNS on Cloudflare (proxied), served via GitHub Pages. Email:
  tim@purelysearch.com via Cloudflare Email Routing → Gmail.
