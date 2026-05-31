import { completion, parseSSEStream } from './chat.js';
import { pickToken } from './auth.js';
import { dispatchQueued } from './queue.js';

// ─── Model Configuration (same as openai.js) ──────────────────────────────────
const MODEL_CONFIG = {
  // ── Standard context ──
  'deepseek-v4-flash':                    { modelType: 'default', thinking: true,  search: false },
  'deepseek-v4-pro':                      { modelType: 'expert',  thinking: true,  search: false },
  'deepseek-v4-vision':                   { modelType: 'vision',  thinking: true,  search: false },
  'deepseek-v4-flash-search':             { modelType: 'default', thinking: true,  search: true },
  'deepseek-v4-pro-search':               { modelType: 'expert',  thinking: true,  search: true },
  'deepseek-v4-flash-nothinking':         { modelType: 'default', thinking: false, search: false },
  'deepseek-v4-pro-nothinking':           { modelType: 'expert',  thinking: false, search: false },
  'deepseek-v4-vision-nothinking':        { modelType: 'vision',  thinking: false, search: false },
  'deepseek-v4-flash-search-nothinking':  { modelType: 'default', thinking: false, search: true },
  'deepseek-v4-pro-search-nothinking':    { modelType: 'expert',  thinking: false, search: true },

  // ── 1M context variants ──
  'deepseek-v4-flash[1m]':                    { modelType: 'default', thinking: true,  search: false },
  'deepseek-v4-pro[1m]':                      { modelType: 'expert',  thinking: true,  search: false },
  'deepseek-v4-vision[1m]':                   { modelType: 'vision',  thinking: true,  search: false },
  'deepseek-v4-flash-search[1m]':             { modelType: 'default', thinking: true,  search: true },
  'deepseek-v4-pro-search[1m]':               { modelType: 'expert',  thinking: true,  search: true },
  'deepseek-v4-flash-nothinking[1m]':         { modelType: 'default', thinking: false, search: false },
  'deepseek-v4-pro-nothinking[1m]':           { modelType: 'expert',  thinking: false, search: false },
  'deepseek-v4-vision-nothinking[1m]':        { modelType: 'vision',  thinking: false, search: false },
  'deepseek-v4-flash-search-nothinking[1m]':  { modelType: 'default', thinking: false, search: true },
  'deepseek-v4-pro-search-nothinking[1m]':    { modelType: 'expert',  thinking: false, search: true },
};

function getModelConfig(model) {
  const lower = (model || '').toLowerCase().trim();
  if (MODEL_CONFIG[lower]) return MODEL_CONFIG[lower];
  return null;
}

export async function handleDeepSeekCompletion(req, res) {
  const body = req.body;
  const config = getModelConfig(body.model);
  const modelType = body.model_type || (config ? config.modelType : 'default');
  const prompt = body.prompt || '';
  // Use model config defaults, allow explicit override
  const thinkingEnabled = body.thinking_enabled ?? (config ? config.thinking : false);
  const searchEnabled = body.search_enabled ?? (config ? config.search : false);
  const parentMessageId = body.parent_message_id ?? null;
  const refFileIds = body.ref_file_ids ?? [];

  if (!prompt) {
    return res.status(400).json({ code: 1, msg: 'prompt is required' });
  }

  try {
    const { body: streamBody, slot } = await completion({ modelType, prompt, thinkingEnabled, searchEnabled, parentMessageId, refFileIds });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
    });

    const reader = streamBody.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
    }
    res.end();
  } catch (err) {
    console.error('DeepSeek completion error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ code: 1, msg: err.message });
    } else {
      res.end();
    }
  } finally {
    slot.release();
    dispatchQueued();
  }
}
