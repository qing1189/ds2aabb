import { setRequestToken, reportTokenError, reportTokenSuccess } from './auth.js';
import { solvePowChallenge } from './pow.js';
import { getSession } from './session.js';
import { streamHeaders, proxiedFetch } from './headers.js';
import { enqueueRequest, dispatchQueued } from './queue.js';

const BASE_URL = 'https://chat.deepseek.com';

export async function completion({ modelType, prompt, thinkingEnabled = false, searchEnabled = false, parentMessageId = null, refFileIds = [], preferVision = false }) {
  // Step 1: Solve PoW (no token slot held)
  const { powResponse, token: powToken } = await solvePowChallenge(preferVision);

  // Step 2: Acquire token slot only when ready to send completion
  const slot = await enqueueRequest(preferVision);

  try {
    setRequestToken(slot.token);
    const session = await getSession(slot.token, modelType);
    setRequestToken(null);

    const body = {
      chat_session_id: session.id,
      parent_message_id: parentMessageId,
      model_type: modelType,
      prompt,
      ref_file_ids: refFileIds,
      thinking_enabled: thinkingEnabled,
      search_enabled: searchEnabled,
      preempt: false,
    };

    const res = await proxiedFetch(`${BASE_URL}/api/v0/chat/completion`, {
      method: 'POST',
      headers: streamHeaders(slot.token, powResponse),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      reportTokenError(slot.token);
      const text = await res.text();
      throw new Error(`Completion request failed: ${res.status} ${text}`);
    }

    reportTokenSuccess(slot.token);
    return { body: res.body, slot };
  } catch (err) {
    slot.release();
    dispatchQueued();
    throw err;
  }
}

export async function* parseSSEStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let messageIds = {};
  let currentFragmentType = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          if (line.slice(6).trim() === 'close') return;
          continue;
        }
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;

        try {
          const parsed = JSON.parse(data);

          if (parsed.request_message_id != null) {
            messageIds.requestMessageId = parsed.request_message_id;
            messageIds.responseMessageId = parsed.response_message_id;
          }

          if (parsed.v?.response?.fragments) {
            for (const frag of parsed.v.response.fragments) {
              if (frag.type === 'THINK' && frag.content) {
                currentFragmentType = 'THINK';
                yield { type: 'thinking', content: frag.content, messageIds };
              } else if (frag.type === 'RESPONSE' && frag.content) {
                currentFragmentType = 'RESPONSE';
                yield { type: 'content', content: frag.content, messageIds };
              }
            }
            if (parsed.v.response.accumulated_token_usage != null) {
              yield { type: 'usage', usage: parsed.v.response.accumulated_token_usage, messageIds };
            }
          }

          if (parsed.p && parsed.o) {
            if (parsed.p === 'response/fragments/-1/content' && parsed.o === 'APPEND' && typeof parsed.v === 'string') {
              yield { type: currentFragmentType === 'THINK' ? 'thinking' : 'content', content: parsed.v, messageIds };
            } else if (parsed.p === 'response/fragments/-1/content' && !parsed.o && typeof parsed.v === 'string') {
              yield { type: currentFragmentType === 'THINK' ? 'thinking' : 'content', content: parsed.v, messageIds };
            } else if (parsed.p === 'response/status' && parsed.v === 'FINISHED') {
              yield { type: 'done', messageIds };
            } else if (parsed.p === 'response' && parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
              for (const item of parsed.v) {
                if (item.p === 'accumulated_token_usage') {
                  yield { type: 'usage', usage: item.v, messageIds };
                }
              }
            } else if (parsed.p === 'response/fragments' && parsed.o === 'APPEND' && Array.isArray(parsed.v)) {
              for (const frag of parsed.v) {
                if (frag.type === 'RESPONSE' && frag.content) {
                  currentFragmentType = 'RESPONSE';
                  yield { type: 'content', content: frag.content, messageIds };
                } else if (frag.type === 'THINK' && frag.content) {
                  currentFragmentType = 'THINK';
                  yield { type: 'thinking', content: frag.content, messageIds };
                }
              }
            }
            continue;
          }

          if (typeof parsed.v === 'string') {
            yield { type: currentFragmentType === 'THINK' ? 'thinking' : 'content', content: parsed.v, messageIds };
          }

          if (Array.isArray(parsed.v)) {
            for (const item of parsed.v) {
              if (item.p === 'accumulated_token_usage') {
                yield { type: 'usage', usage: item.v, messageIds };
              }
            }
          }
        } catch {
          // skip unparseable lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
