const Anthropic = require("@anthropic-ai/sdk");

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

  try {
    const { lemma } = JSON.parse(event.body);

    if (!lemma) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing lemma" }) };
    }

    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: lemma }],
      // [LANG-SPECIFIC] The persona is a Korean dictionary assistant (docs/08).
      system: `You are a Korean dictionary assistant. When given a Korean word or phrase, provide a concise English definition in the style of krdict.korean.go.kr. Format: numbered senses like "1. [definition]\\n\\n2. [definition]" etc. Include brief usage context per sense. Be accurate and natural. Return ONLY the definition text, nothing else.`,
    });

    const text = message.content[0]?.text || "";
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