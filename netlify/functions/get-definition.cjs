const Anthropic = require("@anthropic-ai/sdk");
const { verifyUser } = require("../lib/verifyUser.cjs");

// Longest lemma accepted (S-D5). The client already stops at 80 characters.
const MAX_LEMMA_CHARS = 200;

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // Demo mode (D9): AI definitions disabled; the client falls back to
  // 'Definition not found.' and Settings locks dictMode to KRDict anyway.
  if (process.env.DEMO_MODE === 'true') {
    return {
      statusCode: 403,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "disabled in demo" }),
    };
  }

  // Only signed-in users on ALLOWED_UIDS may spend the API key.
  const caller = await verifyUser(event.headers?.authorization || event.headers?.Authorization);
  if (!caller.ok) {
    return {
      statusCode: caller.status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: caller.error }),
    };
  }

  try {
    const { lemma } = JSON.parse(event.body);

    if (!lemma || typeof lemma !== "string") {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing lemma" }) };
    }
    if (lemma.length > MAX_LEMMA_CHARS) {
      return { statusCode: 400, body: JSON.stringify({ error: "Lemma too long" }) };
    }

    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    // P4: Claude Haiku 5.5 (Haiku 4.5 is a legacy model past its earliest
    // retirement date). Haiku 5.5 thinks by default; a short definition
    // doesn't need it, so thinking is off ("disabled" is accepted at the
    // default effort).
    const message = await client.messages.create({
      model: "claude-haiku-5-5",
      max_tokens: 1024,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: lemma }],
      // [LANG-SPECIFIC] The persona is a Korean dictionary assistant (docs/08).
      system: `You are a Korean dictionary assistant. When given a Korean word or phrase, provide a concise English definition in the style of krdict.korean.go.kr. Format: numbered senses like "1. [definition]\\n\\n2. [definition]" etc. Include brief usage context per sense. Be accurate and natural. Return ONLY the definition text, nothing else.`,
    });

    // Read the text block by type (a thinking block can come first on
    // newer models). A refusal or an empty reply returns '', which the app
    // treats as "dictionary unreachable", not as a miss (A12).
    const text = (message.content || []).find(b => b.type === "text")?.text || "";
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ definition: text }),
    };
  } catch (err) {
    console.error("get-definition error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};