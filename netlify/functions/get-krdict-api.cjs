const https = require("https");
const { verifyUser } = require("../lib/verifyUser.cjs");

// [LANG-SPECIFIC] KRDict is the Korean dictionary provider; swap the API
// endpoint and response parsing for another language (docs/08).

// Demo burst fence (D3): a per-warm-instance rolling counter. The demo caps
// are the real limiter (a public-tier visitor can trigger only a handful of
// lookups); this only blunts scripted bursts. The KRDict key's own daily
// quota is the backstop.
let fenceWindowStart = 0;
let fenceCount = 0;
const FENCE_MAX = 300;            // requests per window per warm instance
const FENCE_WINDOW_MS = 3600000;  // 1 hour

// L1 (lemma repair, Oct 2026). Netlify stops a synchronous
// function at 10 seconds, so every attempt has to finish inside one shared
// budget. The Oct 18 log showed a warm instance whose connection to KRDict
// went bad: attempt 1 failed instantly ("fetch failed"), every retry then
// hung to its 8-second timeout (~30s total, so the browser saw a 504), and
// the next call on a fresh instance succeeded in under 2 seconds. Each
// attempt therefore opens its own socket (agent: false) instead of reusing
// a pooled connection, and all attempts share an 8.5-second deadline.
const BUDGET_MS = 8500;
const ATTEMPT_MS = 4000;
const KRDICT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; AutoVocaIndex/1.0)",
  "Accept": "application/xml, text/xml, */*",
};

function getText(url, timeoutMs, redirectsLeft = 2) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, val) => { if (!settled) { settled = true; clearTimeout(timer); fn(val); } };
    const req = https.get(url, { agent: false, headers: KRDICT_HEADERS }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        getText(next, timeoutMs, redirectsLeft - 1).then(v => finish(resolve, v), e => finish(reject, e));
        return;
      }
      if (code < 200 || code >= 300) {
        res.resume();
        finish(reject, new Error(`HTTP ${code}`));
        return;
      }
      res.setEncoding("utf8");
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => finish(resolve, body));
      res.on("error", (err) => finish(reject, err));
    });
    // Hard deadline for the whole attempt (connect + response + body).
    const timer = setTimeout(() => {
      req.destroy(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    req.on("error", (err) => finish(reject, err));
  });
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (process.env.DEMO_MODE === 'true') {
    const now = Date.now();
    if (now - fenceWindowStart > FENCE_WINDOW_MS) {
      fenceWindowStart = now;
      fenceCount = 0;
    }
    fenceCount++;
    if (fenceCount > FENCE_MAX) {
      return { statusCode: 429, body: JSON.stringify({ error: "Rate limited" }) };
    }
  }

  // Only signed-in users on ALLOWED_UIDS may use the KRDict key. Demo site:
  // any signed-in demo visitor (anonymous uids can't be listed); the token is
  // still required and verified, and the burst fence above still applies.
  const caller = await verifyUser(
    event.headers?.authorization || event.headers?.Authorization,
    { requireAllowlist: process.env.DEMO_MODE !== 'true' },
  );
  if (!caller.ok) {
    return {
      statusCode: caller.status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: caller.error }),
    };
  }

  try {
    const { lemma, lang } = JSON.parse(event.body);
    if (!lemma) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing lemma" }) };
    }

    const apiKey = process.env.KRDICT_API_KEY;
    if (!apiKey) {
      console.error("KRDICT_API_KEY is not set in environment variables");
      return { statusCode: 400, body: JSON.stringify({ error: "No KRDict API key configured" }) };
    }

    console.log("KRDict API call for lemma:", lemma, "lang:", lang);

    const url = `https://krdict.korean.go.kr/api/search?key=${apiKey}&q=${encodeURIComponent(lemma)}&translated=y&trans_lang=1&sort=dict&start=1&num=10&part=word`;

    // Up to 3 attempts, each on a fresh socket, all inside BUDGET_MS so the
    // function always answers before Netlify's 10-second cutoff.
    const deadline = Date.now() + BUDGET_MS;
    let xml = "";
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 250));
      const remaining = deadline - Date.now();
      if (remaining < 1000) break;
      try {
        xml = await getText(url, Math.min(ATTEMPT_MS, remaining));
        lastError = null;
        break;
      } catch (err) {
        lastError = err.message || String(err);
        console.warn(`Attempt ${attempt + 1} failed:`, lastError);
      }
    }

    if (lastError) {
      console.error("All attempts failed:", lastError);
      // 503 + transient: the client treats this as "couldn't reach KRDict",
      // never as "no definition exists".
      return {
        statusCode: 503,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: lastError, transient: true }),
      };
    }

    console.log("KRDict API response status: success, total chars:", xml.length);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ xml }),
    };
  } catch (err) {
    console.error("get-krdict-api error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};