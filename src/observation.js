import { randomUUID } from 'node:crypto';

// Pure helpers for execution observations. No DB access, no scoring logic.
// Missing upstream values stay null; this layer never coerces "absent" to 0.
export function newRequestId() {
  return randomUUID();
}

export function extractContentText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

// ---------------------------------------------------------------------------
// Validation statuses. Documented vocabulary for request_events.
// - `unvalidated`:     not enough information, or no explicit validation yet.
// - `completed`:       non-empty response with finish_reason=stop (API-level
//                      completion only; NOT functional success).
// - `truncated`:       finish_reason=length (takes precedence over `empty`
//                      because it explains the cause; is_empty is still stored).
// - `error`:           HTTP/upstream/selection/internal error.
// - `empty`:           no usable content and no truncation signal.
// - `functional_success` / `functional_failure`: only via explicit later
//                      validation (recordValidation). Never inferred from stop.
// ---------------------------------------------------------------------------
export const VALIDATION_STATUSES = Object.freeze({
  UNVALIDATED: 'unvalidated',
  COMPLETED: 'completed',
  TRUNCATED: 'truncated',
  ERROR: 'error',
  EMPTY: 'empty',
  FUNCTIONAL_SUCCESS: 'functional_success',
  FUNCTIONAL_FAILURE: 'functional_failure',
});

export function classifyObservation({
  isError = null,
  finishReason = null,
  hasContent = null,
  contentLength = null,
  isEmpty = null,
} = {}) {
  if (isError === true || isError === 1) return VALIDATION_STATUSES.ERROR;
  if (finishReason === 'length') return VALIDATION_STATUSES.TRUNCATED;
  if (isEmpty === true || isEmpty === 1 || hasContent === false || contentLength === 0) {
    return VALIDATION_STATUSES.EMPTY;
  }
  if (
    finishReason === 'stop' &&
    (hasContent === true || (typeof contentLength === 'number' && contentLength > 0))
  ) {
    return VALIDATION_STATUSES.COMPLETED;
  }
  return VALIDATION_STATUSES.UNVALIDATED;
}

export function extractObservation({ upstreamRequest = {}, data = {} } = {}) {
  const choice = data?.choices?.[0] || {};
  const usage = data?.usage || {};
  const completionDetails = usage.completion_tokens_details || {};
  const contentText = extractContentText(choice.message || {});

  return {
    model: data?.model ?? null,
    provider: data?.provider ?? data?.meta?.provider ?? null,
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    // Only the documented OpenRouter location. Absent stays null, not 0.
    reasoningTokens: completionDetails.reasoning_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
    // Realized cost comes only from usage.cost; never recomputed here.
    cost: usage.cost ?? null,
    finishReason: choice.finish_reason ?? null,
    nativeFinishReason: choice.native_finish_reason ?? null,
    maxTokens:
      upstreamRequest.max_tokens ??
      upstreamRequest.max_completion_tokens ??
      null,
    contentLength: contentText.length,
    hasContent: contentText.length > 0,
    isEmpty: contentText.length === 0,
    isError: false,
  };
}

export function extractErrorObservation({
  upstreamRequest = {},
  status = null,
  error = null,
} = {}) {
  return {
    model: null,
    provider: null,
    promptTokens: null,
    completionTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    cost: null,
    finishReason: null,
    nativeFinishReason: null,
    maxTokens:
      upstreamRequest.max_tokens ??
      upstreamRequest.max_completion_tokens ??
      null,
    contentLength: null,
    hasContent: null,
    isEmpty: null,
    isError: true,
    status,
    error,
  };
}

// ---------------------------------------------------------------------------
// SSE streaming helpers. Relay stays byte-identical; these only summarize
// what the upstream sent so the relay loop can persist an observation.
// - `relayStreamChunks`: async generator yielding raw chunks untouched.
// - `summarizeStreamEvents`: folds parsed `data:` payloads. Only fields the
//   upstream actually sent are populated; everything else stays null.
//   `provider`/`model` may arrive in the first packet or in the terminal
//   `usage` packet; finish reasons may arrive per-choice in `choices[0]` or
//   in the terminal packet. Last non-null value wins; nothing is invented.
// ---------------------------------------------------------------------------
export async function* relayStreamChunks(upstreamBody) {
  if (!upstreamBody) return;
  for await (const chunk of upstreamBody) {
    yield chunk;
  }
}

function appendDeltaText(state, delta) {
  if (!delta) return 0;
  if (typeof delta.content === 'string') {
    state.parts.push(delta.content);
    if (delta.content.length > 0) state.hasText = true;
    return delta.content.length;
  }
  return 0;
}

function readChoicePacket(packet, state) {
  const choice = packet?.choices?.[0];
  if (!choice) return;
  if (typeof packet.model === 'string' && packet.model.length > 0) {
    state.model = packet.model;
  }
  if (typeof packet.provider === 'string' && packet.provider.length > 0) {
    state.provider = packet.provider;
  }
  if (!state.finishReason && choice.finish_reason != null) {
    state.finishReason = String(choice.finish_reason);
  }
  if (!state.nativeFinishReason && choice.native_finish_reason != null) {
    state.nativeFinishReason = String(choice.native_finish_reason);
  }
  const message = choice.message;
  if (typeof message?.content === 'string') {
    state.contentLength += message.content.length;
    state.hasText = state.hasText || message.content.length > 0;
  }
  state.contentLength += appendDeltaText(state, choice.delta);
}

function readUsagePacket(packet, state) {
  const usage = packet?.usage;
  if (!usage || typeof usage !== 'object') return;
  if (typeof packet.model === 'string' && packet.model.length > 0 && !state.model) {
    state.model = packet.model;
  }
  if (typeof packet.provider === 'string' && packet.provider.length > 0 && !state.provider) {
    state.provider = packet.provider;
  }
  if (usage.prompt_tokens != null && state.promptTokens == null) {
    state.promptTokens = usage.prompt_tokens;
  }
  if (usage.completion_tokens != null && state.completionTokens == null) {
    state.completionTokens = usage.completion_tokens;
  }
  if (usage.total_tokens != null && state.totalTokens == null) {
    state.totalTokens = usage.total_tokens;
  }
  if (usage.cost != null && state.cost == null) {
    state.cost = usage.cost;
  }
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (reasoning != null && state.reasoningTokens == null) {
    state.reasoningTokens = reasoning;
  }
}

export function summarizeStreamEvents(events, upstreamRequest = {}) {
  const state = {
    model: null,
    provider: null,
    promptTokens: null,
    completionTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    cost: null,
    finishReason: null,
    nativeFinishReason: null,
    contentLength: 0,
    hasText: false,
    sawAnyPacket: false,
    sawDone: false,
    parts: [],
  };
  for (const event of events || []) {
    if (event === '[DONE]') {
      state.sawDone = true;
      continue;
    }
    let packet = null;
    try {
      packet = JSON.parse(event);
    } catch {
      continue;
    }
    state.sawAnyPacket = true;
    readChoicePacket(packet, state);
    readUsagePacket(packet, state);
  }
  return {
    model: state.model,
    provider: state.provider,
    promptTokens: state.promptTokens,
    completionTokens: state.completionTokens,
    reasoningTokens: state.reasoningTokens,
    totalTokens: state.totalTokens,
    cost: state.cost,
    finishReason: state.finishReason,
    nativeFinishReason: state.nativeFinishReason,
    maxTokens:
      upstreamRequest.max_tokens ??
      upstreamRequest.max_completion_tokens ??
      null,
    contentLength: state.sawAnyPacket ? state.contentLength : null,
    hasContent: state.sawAnyPacket ? state.hasText : null,
    isEmpty: state.sawAnyPacket ? !state.hasText : null,
    isError: false,
  };
}

// Splits a raw SSE byte buffer into completed `data:` payload strings while
// keeping an incomplete tail for the next chunk. Control lines (`:`) and
// non-data lines are ignored.
export function splitSsePayloads(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer ?? '');
  const events = [];
  const lines = text.split('\n');
  let remainder = '';
  if (!text.endsWith('\n')) {
    remainder = lines.pop() ?? '';
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    events.push(trimmed.slice(5).trim());
  }
  return { events, remainder };
}
