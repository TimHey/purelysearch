// PurelySearch edge worker — runs on Cloudflare in front of the static GitHub
// Pages site (the domain is proxied through Cloudflare, so this is the only
// place that sees crawlers and agents before the cache). Agents don't run
// JavaScript, so GA4 never sees them; this does.
//
// Two jobs:
//   1. Log agent/crawler hits to Upstash Redis (best-effort, off the response
//      path via waitUntil). Keys are namespaced "ps:" so they don't collide
//      with other projects sharing the same Upstash database.
//   2. Serve GET /api/agent-traffic (live JSON counters) for the /agents page.
// Everything else passes straight through to the origin (GitHub Pages).

const NS = "ps:";
const DAY_TTL = 60 * 60 * 24 * 120; // keep per-day hashes ~120 days
const RECENT_MAX = 199;

// Known agent + crawler user-agents. Substring match on a lowercased UA.
const AGENT_UAS = [
  ["gptbot", "OpenAI GPTBot"],
  ["oai-searchbot", "OpenAI SearchBot"],
  ["chatgpt-user", "OpenAI ChatGPT-User"],
  ["claudebot", "Anthropic ClaudeBot"],
  ["claude-user", "Anthropic Claude-User"],
  ["claude-searchbot", "Anthropic Claude-SearchBot"],
  ["claude-web", "Anthropic Claude-Web"],
  ["anthropic-ai", "Anthropic"],
  ["perplexitybot", "Perplexity"],
  ["perplexity-user", "Perplexity-User"],
  ["google-extended", "Google-Extended"],
  ["googlebot", "Googlebot"],
  ["bingbot", "Bingbot"],
  ["applebot-extended", "Applebot-Extended"],
  ["applebot", "Applebot"],
  ["ccbot", "Common Crawl"],
  ["bytespider", "ByteDance"],
  ["amazonbot", "Amazon"],
  ["meta-externalagent", "Meta"],
  ["facebookexternalhit", "Meta"],
  ["cohere-ai", "Cohere"],
  ["diffbot", "Diffbot"],
  ["youbot", "You.com"],
  ["duckassistbot", "DuckDuckGo"],
];

// Surfaces built for agents. A hit here is worth logging even when the UA isn't
// one we recognize — an unknown agent pulling llms.txt is exactly the signal.
function isAgentSurface(path) {
  return path === "/llms.txt" || path.startsWith("/.well-known/");
}

function identify(ua) {
  const l = ua.toLowerCase();
  for (const [sig, name] of AGENT_UAS) if (l.includes(sig)) return name;
  return null;
}

function utcDay(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function pipeline(env, cmds) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token || cmds.length === 0) return null;
  try {
    const res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(cmds),
    });
    if (!res.ok) return null;
    const out = await res.json();
    return out.map((o) => (o && "result" in o ? o.result : null));
  } catch {
    return null; // never let a logging failure surface to a visitor
  }
}

function hashToCounts(v) {
  const out = {};
  if (Array.isArray(v)) {
    for (let i = 0; i + 1 < v.length; i += 2) out[String(v[i])] = Number(v[i + 1]);
  } else if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v)) out[k] = Number(val);
  }
  return out;
}

async function record(env, hit) {
  const now = new Date();
  const day = utcDay(now);
  const entry = JSON.stringify({ ...hit, day, ts: now.toISOString() });
  await pipeline(env, [
    ["HINCRBY", `${NS}agents:totals`, hit.agent, 1],
    ["HINCRBY", `${NS}agents:day:${day}`, hit.agent, 1],
    ["EXPIRE", `${NS}agents:day:${day}`, DAY_TTL],
    ["HINCRBY", `${NS}agents:paths`, hit.path, 1],
    ["LPUSH", `${NS}agents:recent`, entry],
    ["LTRIM", `${NS}agents:recent`, 0, RECENT_MAX],
  ]);
}

async function readStats(env, days = 14) {
  const now = new Date();
  const dayKeys = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setUTCDate(now.getUTCDate() - i);
    dayKeys.push(utcDay(d));
  }
  const res = await pipeline(env, [
    ["HGETALL", `${NS}agents:totals`],
    ["HGETALL", `${NS}agents:paths`],
    ["LRANGE", `${NS}agents:recent`, 0, 49],
    ...dayKeys.map((k) => ["HGETALL", `${NS}agents:day:${k}`]),
  ]);
  if (!res) return null;
  const totals = hashToCounts(res[0]);
  const paths = hashToCounts(res[1]);
  const recent = (Array.isArray(res[2]) ? res[2] : [])
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const byDay = dayKeys.map((day, i) => {
    const agents = hashToCounts(res[3 + i]);
    const total = Object.values(agents).reduce((a, b) => a + b, 0);
    return { day, total, agents };
  });
  return { totals, paths, recent, byDay };
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Live counters endpoint — handled by the worker, never passed to origin.
    if (path === "/api/agent-traffic") {
      const configured = Boolean(
        env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN,
      );
      if (!configured) {
        return new Response(
          JSON.stringify({ configured: false, message: "Store not configured." }),
          { headers: JSON_HEADERS },
        );
      }
      const stats = await readStats(env);
      return new Response(JSON.stringify({ configured: true, ...stats }), {
        headers: JSON_HEADERS,
      });
    }

    // Log agent hits, then pass through. Only count GETs so HEAD/OPTIONS noise
    // and asset fetches on recognized bots stay out of the way.
    const ua = request.headers.get("user-agent") ?? "";
    const agent = identify(ua);
    const surface = isAgentSurface(path);
    if ((agent || surface) && request.method === "GET") {
      ctx.waitUntil(record(env, { agent: agent ?? "unknown", surface, path }));
    }

    return fetch(request);
  },
};
