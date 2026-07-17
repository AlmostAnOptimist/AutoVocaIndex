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

    // Retry up to 2 times on connection reset
    let xml = "";
    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        if (attempt > 0) await new Promise(r => setTimeout(r, 500));
        const resp = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; AutoVocaIndex/1.0)",
            "Accept": "application/xml, text/xml, */*",
          },
          signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) {
          lastError = `HTTP ${resp.status}`;
          continue;
        }
        xml = await resp.text();
        lastError = null;
        break;
      } catch (err) {
        lastError = err.message;
        console.warn(`Attempt ${attempt + 1} failed:`, err.message);
      }
    }

    if (lastError) {
      console.error("All attempts failed:", lastError);
      return { statusCode: 502, body: JSON.stringify({ error: lastError }) };
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