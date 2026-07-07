/**
 * Minimal Ollama client, shared by the resume-profile extractor
 * (build-profile.js) and the ambiguity router (route-resumes.js).
 *
 * Both talk to a model running on localhost, so resume text and job text
 * never leave the machine. Plain global fetch (Node >=18), zero dependencies,
 * so `npm test` and CI stay dependency-free.
 *
 * One env knob for both scripts:
 *   OLLAMA_MODEL   default model tag (e.g. qwen2.5:7b-instruct)
 *   OLLAMA_URL     base URL (default http://127.0.0.1:11434)
 */

const DEFAULT_BASE_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct';

async function ollamaAvailable(baseUrl = DEFAULT_BASE_URL) {
  try {
    const response = await fetch(`${baseUrl}/api/tags`);
    return response.ok;
  } catch {
    return false;
  }
}

// Single-shot structured chat. `format` is a JSON schema Ollama constrains the
// output to (it compiles the schema to a grammar). Returns the parsed JSON
// object, or null if the model emitted something unparseable. Throws on an
// HTTP error so the caller can decide how loudly to fail.
async function ollamaChat({ baseUrl = DEFAULT_BASE_URL, model = DEFAULT_MODEL, system, user, format, options }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: false, messages, format, options })
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`ollama ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = await response.json();
  try {
    return JSON.parse(data.message?.content ?? '');
  } catch {
    return null;
  }
}

module.exports = { DEFAULT_BASE_URL, DEFAULT_MODEL, ollamaAvailable, ollamaChat };
