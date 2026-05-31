import { completion, parseSSEStream } from './chat.js';
import { resolveImageToRefId } from './upload.js';
import { enqueueRequest, dispatchQueued } from './queue.js';
import { randomUUID } from 'crypto';

// ─── Model Configuration ───────────────────────────────────────────────────────
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

const MODEL_ALIASES = {
  'deepseek-chat':        'deepseek-v4-flash',
  'deepseek-reasoner':    'deepseek-v4-flash',
  'deepseek-coder':       'deepseek-v4-flash',

  'gpt-4':                'deepseek-v4-flash',
  'gpt-4-turbo':          'deepseek-v4-flash',
  'gpt-4o':               'deepseek-v4-flash',
  'gpt-4o-mini':          'deepseek-v4-flash',
  'gpt-4.1':              'deepseek-v4-flash',
  'gpt-4.1-mini':         'deepseek-v4-flash',
  'gpt-4.1-nano':         'deepseek-v4-flash',

  'o1':                   'deepseek-v4-pro',
  'o1-mini':              'deepseek-v4-pro',
  'o1-preview':           'deepseek-v4-pro',
  'o3':                   'deepseek-v4-pro',
  'o3-mini':              'deepseek-v4-pro',
  'o4-mini':              'deepseek-v4-pro',

  'claude-sonnet-4-6':          'deepseek-v4-flash',
  'claude-sonnet-4-5':          'deepseek-v4-flash',
  'claude-haiku-4-5':           'deepseek-v4-flash',
  'claude-opus-4-6':            'deepseek-v4-pro',
  'claude-opus-4-1':            'deepseek-v4-pro',
  'claude-3-5-sonnet-latest':   'deepseek-v4-flash',
  'claude-3-7-sonnet-latest':   'deepseek-v4-flash',

  'gemini-2.5-pro':       'deepseek-v4-pro',
  'gemini-2.5-flash':     'deepseek-v4-flash',
  'gemini-2.0-flash':     'deepseek-v4-flash',
  'gemini-pro':           'deepseek-v4-pro',
  'gemini-pro-vision':    'deepseek-v4-vision',
};

function resolveModel(model) {
  const lower = model.toLowerCase().trim();
  if (MODEL_CONFIG[lower]) return lower;
  if (MODEL_ALIASES[lower]) return MODEL_ALIASES[lower];
  return null;
}

function getModelConfig(model) {
  const resolved = resolveModel(model);
  if (!resolved) {
    const available = Object.keys(MODEL_CONFIG).join(', ');
    throw new Error(`Unknown model: ${model}. Available: ${available}`);
  }
  return { resolved, ...MODEL_CONFIG[resolved] };
}

async function extractImages(messages, token) {
  const refFileIds = [];
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'image_url' && part.image_url?.url) {
          try {
            const fileId = await resolveImageToRefId(part.image_url.url, token);
            refFileIds.push(fileId);
          } catch (err) {
            console.error('Image upload failed:', err.message);
          }
        }
      }
    }
  }
  return refFileIds;
}

// ─── Message Building (Passthrough) ──────────────────────────────────────────
// No special tool prompt injection. Client already teaches the model its format.
// We just transparently pass tool/assistant history as natural conversation context.

function buildPrompt(messages) {
  let prompt = '';
  for (const msg of messages) {
    const role = msg.role || 'user';

    if (role === 'system') {
      const content = normalizeContent(msg.content);
      if (content) prompt += `[System]: ${content}\n\n`;
    } else if (role === 'user') {
      const content = normalizeContent(msg.content);
      if (content) prompt += `[User]: ${content}\n\n`;
    } else if (role === 'assistant') {
      let content = normalizeContent(msg.content);
      if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        const callsText = msg.tool_calls.map(tc => {
          const fn = tc.function || {};
          return `${fn.name}(${fn.arguments || '{}'})`;
        }).join('\n');
        content = content
          ? `${content}\n\n[Tool Calls]:\n${callsText}`
          : `[Tool Calls]:\n${callsText}`;
      }
      if (content) prompt += `[Assistant]: ${content}\n\n`;
    } else if (role === 'tool') {
      const name = msg.name || 'unknown';
      const content = normalizeContent(msg.content);
      prompt += `[Tool Result (${name})]: ${content}\n\n`;
    }
  }
  return prompt.trim();
}

function normalizeContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n');
  }
  return String(content);
}

// ─── Tool Call Detection (Post-processing) ───────────────────────────────────
// After receiving the model's full output, detect if it contains tool calls
// in a format the client taught it. Only activated when request has `tools`.
// No special markers injected — we just parse what the model naturally outputs.

/**
 * Attempt to extract tool calls from model output text.
 * Matches against the tool names provided in the request.
 * 
 * Supported detection patterns:
 * 1. JSON code blocks: ```json\n[{...}]\n``` or ```\n{...}\n```
 * 2. Raw JSON objects/arrays at the start/end of output
 * 3. Multiple function call patterns: {"name":"x","arguments":{...}}
 * 
 * @param {string} text - Model output text
 * @param {Set<string>} toolNameSet - Set of valid tool names from request
 * @returns {Array|null} Array of tool_calls or null if no match
 */
function detectToolCalls(text, toolNameSet) {
  if (!text || toolNameSet.size === 0) return null;

  const candidates = extractJSONCandidates(text);

  for (const candidate of candidates) {
    const calls = parseAsToolCalls(candidate, toolNameSet);
    if (calls && calls.length > 0) return calls;
  }

  return null;
}

/**
 * Extract JSON candidate strings from text.
 * Looks for JSON in code blocks and raw JSON in the text.
 */
function extractJSONCandidates(text) {
  const candidates = [];

  // 1. JSON inside markdown code blocks: ```json\n...\n``` or ```\n...\n```
  const codeBlockRe = /```(?:json)?\s*\n?([\s\S]*?)```/g;
  let match;
  while ((match = codeBlockRe.exec(text)) !== null) {
    const content = match[1].trim();
    if (content) candidates.push(content);
  }

  // 2. Try the entire text as JSON (model might output pure JSON)
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    candidates.push(trimmed);
  }

  // 3. Find JSON objects/arrays anywhere in text (outside code blocks)
  //    Look for patterns like {"name": "..." ...} 
  const jsonObjectRe = /\{[\s\S]*?"name"\s*:\s*"[^"]+?"[\s\S]*?\}/g;
  while ((match = jsonObjectRe.exec(text)) !== null) {
    candidates.push(match[0]);
  }

  return candidates;
}

/**
 * Try to parse a JSON string as one or more tool calls.
 * Validates that function names are in the allowed set.
 */
function parseAsToolCalls(jsonStr, toolNameSet) {
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Try to fix common issues: trailing commas, etc.
    try {
      parsed = JSON.parse(jsonStr.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }

  // Normalize to array
  if (!Array.isArray(parsed)) {
    parsed = [parsed];
  }

  const toolCalls = [];
  for (const item of parsed) {
    const call = extractSingleToolCall(item, toolNameSet);
    if (call) toolCalls.push(call);
  }

  // Only return if ALL items were valid tool calls (avoid false positives)
  if (toolCalls.length > 0 && toolCalls.length === parsed.length) {
    return toolCalls;
  }

  return null;
}

/**
 * Extract a single tool call from a parsed JSON object.
 * Supports multiple common formats:
 *   - OpenAI style: {name: "fn", arguments: {...}}
 *   - Alt style: {function: "fn", parameters: {...}}
 *   - Wrapped: {function: {name: "fn", arguments: "..."}}
 *   - Tool use: {type: "function", function: {name: "fn", arguments: "..."}}
 */
function extractSingleToolCall(obj, toolNameSet) {
  if (!obj || typeof obj !== 'object') return null;

  let name = null;
  let args = null;

  // Pattern 1: {type: "function", function: {name, arguments}}  (OpenAI native)
  if (obj.type === 'function' && obj.function && typeof obj.function === 'object') {
    name = obj.function.name;
    args = obj.function.arguments;
  }
  // Pattern 2: {name: "fn", arguments: {...}} or {name: "fn", parameters: {...}}
  else if (obj.name && typeof obj.name === 'string') {
    name = obj.name;
    args = obj.arguments ?? obj.parameters ?? obj.input ?? {};
  }
  // Pattern 3: {function: "fn", parameters: {...}} or {function: "fn", arguments: {...}}
  else if (obj.function && typeof obj.function === 'string') {
    name = obj.function;
    args = obj.parameters ?? obj.arguments ?? obj.input ?? {};
  }
  // Pattern 4: {function: {name: "fn", arguments: "..."}}
  else if (obj.function && typeof obj.function === 'object' && obj.function.name) {
    name = obj.function.name;
    args = obj.function.arguments ?? obj.function.parameters ?? {};
  }
  // Pattern 5: {tool: "fn", input: {...}}
  else if (obj.tool && typeof obj.tool === 'string') {
    name = obj.tool;
    args = obj.input ?? obj.arguments ?? obj.parameters ?? {};
  }

  if (!name || !toolNameSet.has(name)) return null;

  // Normalize arguments to string
  const argsStr = typeof args === 'string' ? args : JSON.stringify(args || {});

  return {
    id: `call_${randomUUID().replace(/-/g, '')}`,
    type: 'function',
    function: {
      name,
      arguments: argsStr,
    },
  };
}

/**
 * Get tool names from the request's tools array.
 */
function getToolNameSet(tools) {
  const names = new Set();
  if (!Array.isArray(tools)) return names;
  for (const tool of tools) {
    const fn = tool.function || tool;
    if (fn && fn.name) names.add(fn.name);
  }
  return names;
}

// ─── Main Handler ────────────────────────────────────────────────────────────

export async function handleOpenAICompletion(req, res) {
  const { model, messages, stream = false, tools, tool_choice } = req.body;

  if (!model || !messages || !messages.length) {
    return res.status(400).json({ error: { message: 'model and messages are required' } });
  }

  const config = getModelConfig(model);
  const modelType = config.modelType;
  const prompt = buildPrompt(messages);
  const thinkingEnabled = req.body.thinking_enabled ?? config.thinking;
  const searchEnabled = req.body.search_enabled ?? config.search;

  // Determine if we should try to detect tool calls in output
  const toolNameSet = getToolNameSet(tools);
  const shouldDetectTools = toolNameSet.size > 0 && tool_choice !== 'none';

  const requestId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let result;

  try {
    let refFileIds = [];
    let uploadSlot = null;
    if (modelType === 'vision') {
      uploadSlot = await enqueueRequest(true);
      try {
        refFileIds = await extractImages(messages, uploadSlot.token);
      } finally {
        uploadSlot.release();
        dispatchQueued();
      }
    }

    result = await completion({ modelType, prompt, thinkingEnabled, searchEnabled, refFileIds, preferVision: modelType === 'vision' });
  } catch (err) {
    console.error('Completion error:', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }

  const { body: streamBody, slot } = result;

  try {
    if (stream) {
      await handleStreamResponse(res, streamBody, { requestId, model, thinkingEnabled, shouldDetectTools, toolNameSet });
    } else {
      await handleNonStreamResponse(res, streamBody, { requestId, model, thinkingEnabled, shouldDetectTools, toolNameSet });
    }
  } catch (err) {
    console.error('Stream error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message } });
    } else {
      res.end();
    }
  } finally {
    slot.release();
    dispatchQueued();
  }
}

// ─── Non-streaming response ──────────────────────────────────────────────────

async function handleNonStreamResponse(res, streamBody, { requestId, model, thinkingEnabled, shouldDetectTools, toolNameSet }) {
  let fullContent = '';
  let fullThinking = '';
  let usage = 0;
  let inThinkingPhase = thinkingEnabled;

  for await (const event of parseSSEStream(streamBody)) {
    if (event.type === 'content') {
      fullContent += event.content;
      inThinkingPhase = false;
    } else if (event.type === 'thinking' && inThinkingPhase) {
      fullThinking += event.content;
    } else if (event.type === 'usage') {
      usage = event.usage;
    }
  }

  // Try to detect tool calls in the output
  let finishReason = 'stop';
  const messageObj = { role: 'assistant', content: fullContent };

  if (fullThinking) {
    messageObj.reasoning_content = fullThinking;
  }

  if (shouldDetectTools) {
    const detectedCalls = detectToolCalls(fullContent, toolNameSet);
    if (detectedCalls) {
      finishReason = 'tool_calls';
      messageObj.tool_calls = detectedCalls;
      messageObj.content = null;
    }
  }

  res.json({
    id: requestId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: messageObj,
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: usage,
      total_tokens: usage,
    },
  });
}

// ─── Streaming response ──────────────────────────────────────────────────────
// When tools are present: buffer all content, detect at the end.
// If tool calls found → emit tool_calls chunk instead of content.
// If no tools or no detection → stream normally in real-time.

async function handleStreamResponse(res, streamBody, { requestId, model, thinkingEnabled, shouldDetectTools, toolNameSet }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Initial role chunk
  sendChunk(res, requestId, model, { role: 'assistant' });

  let inThinkingPhase = thinkingEnabled;

  if (shouldDetectTools) {
    // Buffer mode: collect everything, detect tools at the end
    let fullContent = '';
    let fullThinking = '';

    for await (const event of parseSSEStream(streamBody)) {
      if (event.type === 'content') {
        fullContent += event.content;
        inThinkingPhase = false;
      } else if (event.type === 'thinking' && inThinkingPhase) {
        fullThinking += event.content;
        // Stream thinking in real-time (it's not affected by tool detection)
        sendChunk(res, requestId, model, { reasoning_content: event.content });
      } else if (event.type === 'done') {
        // Detection phase
        const detectedCalls = detectToolCalls(fullContent, toolNameSet);

        if (detectedCalls) {
          // Emit tool calls as a single chunk
          sendChunk(res, requestId, model, {
            tool_calls: detectedCalls.map((tc, i) => ({ ...tc, index: i })),
          });
          sendFinishChunk(res, requestId, model, 'tool_calls');
        } else {
          // No tool calls detected — emit buffered content as one chunk
          if (fullContent) {
            sendChunk(res, requestId, model, { content: fullContent });
          }
          sendFinishChunk(res, requestId, model, 'stop');
        }
      }
    }
  } else {
    // Pass-through mode: stream content in real-time (no tool detection)
    for await (const event of parseSSEStream(streamBody)) {
      if (event.type === 'content') {
        inThinkingPhase = false;
        sendChunk(res, requestId, model, { content: event.content });
      } else if (event.type === 'thinking' && inThinkingPhase) {
        sendChunk(res, requestId, model, { reasoning_content: event.content });
      } else if (event.type === 'done') {
        sendFinishChunk(res, requestId, model, 'stop');
      }
    }
  }

  res.end();
}

// ─── SSE helpers ─────────────────────────────────────────────────────────────

function sendChunk(res, id, model, delta) {
  res.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`);
}

function sendFinishChunk(res, id, model, finishReason) {
  res.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  })}\n\n`);
  res.write('data: [DONE]\n\n');
}

// ─── Models endpoint ─────────────────────────────────────────────────────────

export function handleOpenAIModels(req, res) {
  res.json({
    object: 'list',
    data: Object.keys(MODEL_CONFIG).map((id) => ({
      id,
      object: 'model',
      created: 1700000000,
      owned_by: 'deepseek',
      permission: [{
        id: `modelperm-${id}`,
        object: 'model_permission',
        created: 1700000000,
        allow_create_engine: false,
        allow_sampling: true,
        allow_logprobs: true,
        allow_search_indices: false,
        allow_view: true,
        allow_fine_tuning: false,
        organization: '*',
        group: null,
        is_blocking: false,
      }],
      // Capability indicators for clients that check these
      capabilities: {
        function_calling: true,
        tool_use: true,
        vision: MODEL_CONFIG[id].modelType === 'vision',
      },
    })),
  });
}

// Also support /v1/models/:id endpoint for individual model lookup
export function handleOpenAIModelById(req, res) {
  const { id } = req.params;
  const resolved = resolveModel(id);
  if (!resolved) {
    return res.status(404).json({ error: { message: `Model '${id}' not found` } });
  }
  res.json({
    id: resolved,
    object: 'model',
    created: 1700000000,
    owned_by: 'deepseek',
    capabilities: {
      function_calling: true,
      tool_use: true,
      vision: MODEL_CONFIG[resolved].modelType === 'vision',
    },
  });
}
