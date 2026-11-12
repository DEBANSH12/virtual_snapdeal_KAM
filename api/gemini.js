// Optional server-side proxy (Vercel serverless function).
// Keeps the Gemini API key on the server so a public demo link works without
// anyone pasting a key. Set GEMINI_API_KEY in the Vercel project settings.
//   GET  /api/gemini  -> { ok: true }  when a key is configured
//   POST /api/gemini  -> forwards { model, body } to Gemini generateContent
module.exports = async function handler(req, res) {
  const key = process.env.GEMINI_API_KEY;
  if (req.method === "GET") return res.status(200).json({ ok: !!key });
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY is not set on the server" });

  const { model, body } = req.body || {};
  if (!/^gemini-[\w.\-]+$/.test(model || "") || !body || JSON.stringify(body).length > 200000) {
    return res.status(400).json({ error: "Bad request" });
  }
  try {
    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body)
    });
    const text = await upstream.text();
    res.status(upstream.status).setHeader("Content-Type", "application/json").send(text);
  } catch (e) {
    res.status(502).json({ error: "Could not reach Gemini: " + e.message });
  }
};
