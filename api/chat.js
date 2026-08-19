// Cached across warm invocations so we only hit /models occasionally.
let cachedModel = null;
let cachedAt = 0;
const CACHE_MS = 10 * 60 * 1000; // 10 minutes

// Preference order. First match against the live model list wins.
// Substring matching, so version bumps (e.g. 3.3 -> 3.4) still match.
const PREFERENCES = [
  'llama-3.3-70b',
  'llama-3.1-70b',
  'llama-3.3',
  'llama-3.1',
  'llama3-70b',
  'llama-4',
  'qwen',
  'gemma2',
  'gemma',
  'mixtral',
  'llama'
];

async function listModels(key) {
  const r = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { 'Authorization': `Bearer ${key}` }
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || 'Could not list models');
  return (data.data || [])
    .map(m => m.id)
    .filter(id => {
      const s = id.toLowerCase();
      // Exclude non-chat models (audio, vision-only, guard, embeddings).
      return !s.includes('whisper')
          && !s.includes('tts')
          && !s.includes('guard')
          && !s.includes('embed');
    });
}

function pickModel(available) {
  for (const pref of PREFERENCES) {
    const hit = available.find(id => id.toLowerCase().includes(pref));
    if (hit) return hit;
  }
  return available[0] || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.GROQ_API_KEY;

  // GET = diagnostics. Shows the live model list and which one we'd pick.
  if (req.method === 'GET') {
    if (!key) return res.status(200).json({ ok: true, keyPresent: false });
    try {
      const available = await listModels(key);
      return res.status(200).json({
        ok: true,
        keyPresent: true,
        selected: pickModel(available),
        available
      });
    } catch (err) {
      return res.status(200).json({ ok: true, keyPresent: true, error: err.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!key) return res.status(500).json({ error: { message: 'GROQ_API_KEY not set' } });

  const { messages, max_tokens } = req.body || {};
  if (!messages) return res.status(400).json({ error: { message: 'No messages provided' } });

  async function send(model) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({ model, messages, max_tokens: max_tokens || 1000 })
    });
    return { ok: r.ok, status: r.status, data: await r.json() };
  }

  try {
    // Use cached model if fresh, otherwise ask Groq what's available.
    if (!cachedModel || Date.now() - cachedAt > CACHE_MS) {
      const available = await listModels(key);
      cachedModel = pickModel(available);
      cachedAt = Date.now();
      if (!cachedModel) {
        return res.status(500).json({ error: { message: 'No chat models available on this key' } });
      }
    }

    let attempt = await send(cachedModel);

    // If the cached model died since we cached it, refresh once and retry.
    if (!attempt.ok) {
      const msg = JSON.stringify(attempt.data).toLowerCase();
      if (msg.includes('model') || attempt.status === 404) {
        const available = await listModels(key);
        cachedModel = pickModel(available);
        cachedAt = Date.now();
        if (cachedModel) attempt = await send(cachedModel);
      }
    }

    if (attempt.ok) return res.status(200).json(attempt.data);

    return res.status(attempt.status).json({
      error: {
        message: attempt.data?.error?.message || 'Request failed',
        model: cachedModel,
        raw: attempt.data
      }
    });

  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}
