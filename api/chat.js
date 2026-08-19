export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET = health check. Confirms function is live and whether key is present.
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      keyPresent: !!process.env.GROQ_API_KEY,
      keyPrefix: process.env.GROQ_API_KEY ? process.env.GROQ_API_KEY.slice(0, 4) : null
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: { message: 'GROQ_API_KEY not set in this deployment' } });
  }

  const { model, messages, max_tokens } = req.body || {};
  if (!messages) {
    return res.status(400).json({ error: { message: 'No messages in request body' } });
  }

  // Try requested model, then fall back through known-good Groq models.
  const candidates = [
    model,
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant'
  ].filter(Boolean).filter((m, i, a) => a.indexOf(m) === i);

  let lastErr = null;

  for (const candidate of candidates) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: candidate,
          messages,
          max_tokens: max_tokens || 1000
        })
      });

      const data = await response.json();

      if (response.ok) {
        return res.status(200).json(data);
      }

      lastErr = { status: response.status, model: candidate, body: data };

      // Only retry on model-related errors; fail fast on auth/quota.
      const msg = JSON.stringify(data).toLowerCase();
      const isModelIssue = msg.includes('model') || msg.includes('decommission') || response.status === 404;
      if (!isModelIssue) break;

    } catch (err) {
      lastErr = { status: 500, model: candidate, body: { message: err.message } };
    }
  }

  return res.status(lastErr?.status || 500).json({
    error: {
      message: lastErr?.body?.error?.message || lastErr?.body?.message || 'All models failed',
      triedModel: lastErr?.model,
      raw: lastErr?.body
    }
  });
}
