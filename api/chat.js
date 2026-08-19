// Cached across warm invocations so we only hit /models occasionally.
let cachedModel = null;
let cachedAt = 0;
const CACHE_MS = 10 * 60 * 1000; // 10 minutes

// Preference order. First match against the live model list wins.
// Substring matching, so version bumps (e.g. 3.3 -> 3.4) still match.
const PREFERENCES = [
  'gpt-oss-120b',
  'gpt-oss',
  'llama-3.3-70b',
  'llama-3.1-70b',
  'llama-3.3',
  'llama-3.1',
  'llama3-70b',
  'llama-4',
  'gemma2',
  'gemma',
  'mixtral',
  'qwen',
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

  // The chat UI renders plain text, so ask for prose instead of markdown.
  // Skipped for JSON-producing prompts (prep-step formatter).
  const wantsJson = messages.some(m =>
    typeof m.content === 'string' && /JSON array/i.test(m.content));

  const outgoing = wantsJson ? messages : (() => {
    const rule = 'Format your reply as plain conversational prose. Do not use markdown: '
      + 'no tables, no pipe characters, no asterisks for bold or italics, no hash headers, '
      + 'no code fences, no horizontal rules. Use short paragraphs. If you need a list, '
      + 'write each item on its own line starting with a dash.';
    const copy = messages.map(m => ({ ...m }));
    const sys = copy.find(m => m.role === 'system');
    if (sys) sys.content = sys.content + '\n\n' + rule;
    else copy.unshift({ role: 'system', content: rule });
    return copy;
  })();

  // Reasoning models (qwen, deepseek-r1) emit <think> blocks. Strip them so
  // the app never shows chain-of-thought and JSON parsing stays clean.
  function stripThinking(text) {
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    // Unclosed <think> means the model ran out of tokens mid-reasoning.
    if (/<think>/i.test(text)) text = text.replace(/<think>[\s\S]*$/i, '');
    return text;
  }

  // Chat bubbles render plain text, so markdown syntax shows up literally.
  // Convert it to readable prose. Skipped when the payload is JSON.
  function stripMarkdown(text) {
    const t = text.trim();
    if (t.startsWith('[') || t.startsWith('{') || t.startsWith('```')) return text;

    return text
      // Tables -> one "cell - cell" line each, header separators dropped.
      .split('\n')
      .filter(line => !/^\s*\|?[\s:|-]{6,}\|?\s*$/.test(line))
      .map(line => {
        if (!/^\s*\|.*\|\s*$/.test(line)) return line;
        return line.trim().replace(/^\||\|$/g, '')
          .split('|').map(c => c.trim()).filter(Boolean).join(' - ');
      })
      .join('\n')
      // Headers, emphasis, code, rules, bullets.
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/(^|[\s(])\*(?!\s)(.+?)(?<!\s)\*(?=[\s).,!?]|$)/g, '$1$2')
      .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
      .replace(/^\s*[-*_]{3,}\s*$/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '\u2022 ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function cleanResponse(data) {
    const msg = data?.choices?.[0]?.message;
    if (!msg || typeof msg.content !== 'string') return data;
    msg.content = stripMarkdown(stripThinking(msg.content)).trim();
    return data;
  }

  async function send(model) {
    // Reasoning models spend budget on hidden thinking, so give extra headroom.
    const isReasoner = /qwen|deepseek|-r1/i.test(model);
    const budget = (max_tokens || 1000) + (isReasoner ? 2000 : 0);
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({ model, messages: outgoing, max_tokens: budget })
    });
    const data = await r.json();
    return { ok: r.ok, status: r.status, data: r.ok ? cleanResponse(data) : data };
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
