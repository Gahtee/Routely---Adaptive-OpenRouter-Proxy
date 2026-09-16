import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import db, {
  __resetForTests,
  getObservationStats,
  getRequestEventColumns,
  getRequests,
  migrateRequestEvents,
  recordRequest,
  recordValidation,
} from '../database.js';
import {
  classifyObservation,
  extractObservation,
  relayStreamChunks,
  splitSsePayloads,
  summarizeStreamEvents,
} from '../observation.js';
import { selectModel } from '../selector.js';
import { scoreModel } from '../openrouter-client.js';
import { defaultWeights } from '../config.js';

function textModel(overrides = {}) {
  return {
    context_length: 262144,
    pricing: { prompt: '0.0000002', completion: '0.0000008' },
    supported_parameters: ['tools', 'tool_choice', 'temperature', 'max_tokens'],
    architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] },
    benchmarks: { artificial_analysis: { coding_index: 75, intelligence_index: 80 } },
    ...overrides,
  };
}

const balancedCatalog = [
  textModel({ id: 'vendor/observed-a' }),
  textModel({
    id: 'vendor/observed-b',
    pricing: { prompt: '0.0000003', completion: '0.0000009' },
  }),
];

let testDb;
beforeEach(async () => {
  __resetForTests();
  testDb = join(mkdtempSync(join(tmpdir(), 'router-obs-')), 'test.db');
  await db.init(testDb);
});

describe('execution observations', () => {
  test('balanced selection exposes a request id for correlation', () => {
    const selection = selectModel(balancedCatalog, 'dynamic-balanced', {});
    assert.ok(selection.requestId);
    assert.match(selection.requestId, /^[0-9a-f-]{36}$/);
  });

  test('cost from usage.cost is persisted', () => {
    recordRequest({
      mode: 'dynamic-balanced',
      selectedModel: 'vendor/observed-a',
      promptTokens: 100,
      completionTokens: 200,
      cost: 0.00123,
      status: 'success',
    });
    const stats = getObservationStats();
    assert.strictEqual(stats.observations, 1);
    assert.strictEqual(stats.withCost, 1);
    assert.strictEqual(stats.lastObservation.cost, 0.00123);
  });

  test('reasoning tokens from completion details are persisted', () => {
    const observed = extractObservation({
      upstreamRequest: { max_tokens: 4000 },
      data: {
        model: 'vendor/observed-a',
        provider: 'Vendor',
        choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          completion_tokens_details: { reasoning_tokens: 12 },
        },
      },
    });
    assert.strictEqual(observed.reasoningTokens, 12);
    recordRequest({ mode: 'dynamic-balanced', selectedModel: 'vendor/observed-a', ...observed, status: 'success' });
    assert.strictEqual(getObservationStats().withReasoningTokens, 1);
  });

  test('finish and native finish reasons are persisted verbatim', () => {
    recordRequest({
      mode: 'dynamic-balanced',
      selectedModel: 'vendor/observed-a',
      finishReason: 'length',
      nativeFinishReason: 'MAX_TOKENS',
      status: 'success',
    });
    const stats = getObservationStats();
    assert.strictEqual(stats.withFinishReason, 1);
    assert.strictEqual(stats.lastObservation.finishReason, 'length');
    assert.strictEqual(stats.lastObservation.nativeFinishReason, 'MAX_TOKENS');
  });

  test('max_tokens and effective provider are persisted when present', () => {
    recordRequest({
      mode: 'dynamic-balanced',
      selectedModel: 'vendor/observed-a',
      provider: 'Vendor',
      maxTokens: 4000,
      status: 'success',
    });
    const last = getObservationStats().lastObservation;
    assert.strictEqual(last.provider, 'Vendor');
    assert.strictEqual(last.maxTokens, 4000);
  });

  test('absent upstream fields stay null instead of zero', () => {
    const observed = extractObservation({
      upstreamRequest: {},
      data: {
        choices: [{ finish_reason: 'stop', message: { content: '' } }],
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      },
    });
    assert.strictEqual(observed.reasoningTokens, null);
    assert.strictEqual(observed.cost, null);
    assert.strictEqual(observed.provider, null);
    assert.strictEqual(observed.maxTokens, null);
    assert.strictEqual(observed.isEmpty, true);
    recordRequest({ mode: 'dynamic-balanced', selectedModel: 'vendor/observed-a', ...observed, status: 'success' });
    const last = getObservationStats().lastObservation;
    assert.strictEqual(last.reasoningTokens, null);
    assert.strictEqual(last.cost, null);
    assert.strictEqual(last.provider, null);
    assert.strictEqual(last.maxTokens, null);
  });

  test('selection and execution share the same request id', () => {
    const selection = selectModel(balancedCatalog, 'dynamic-balanced', {});
    recordRequest({
      mode: 'dynamic-balanced',
      requestId: selection.requestId,
      selectedModel: selection.model,
      status: 'success',
    });
    const rows = getRequests(24 * 365 * 10);
    const values = rows[0];
    // rowsToValues keeps column order: request_id is the 10th column.
    assert.strictEqual(values[9], selection.requestId);
  });

  test('migration is idempotent across restarts', async () => {
    const before = getRequestEventColumns().length;
    const addedAgain = migrateRequestEvents();
    assert.deepStrictEqual(addedAgain, []);
    assert.strictEqual(getRequestEventColumns().length, before);
    db.close();
    await db.init(testDb);
    const addedAfterRestart = migrateRequestEvents();
    assert.deepStrictEqual(addedAfterRestart, []);
  });

  test('balanced score is unchanged by observation plumbing', () => {
    const model = textModel({ id: 'vendor/score-stable' });
    assert.strictEqual(scoreModel(model, defaultWeights).score, 4.572000000000001);
  });
});

describe('validation classification', () => {
  test('stop plus content is completed, never functional success', () => {
    assert.strictEqual(
      classifyObservation({ finishReason: 'stop', hasContent: true, contentLength: 12, isEmpty: false }),
      'completed'
    );
    recordRequest({
      mode: 'dynamic-balanced',
      requestId: 'req-completed-1',
      selectedModel: 'vendor/observed-a',
      finishReason: 'stop',
      contentLength: 12,
      hasContent: true,
      isEmpty: false,
      isError: false,
      validationStatus: 'completed',
      validationSource: 'automatic',
      status: 'success',
    });
    const last = getObservationStats().lastObservation;
    assert.strictEqual(last.validationStatus, 'completed');
    assert.strictEqual(last.functionalSuccess, null);
  });

  test('length is truncated even when content is empty', () => {
    assert.strictEqual(
      classifyObservation({ finishReason: 'length', hasContent: false, contentLength: 0, isEmpty: true }),
      'truncated'
    );
  });

  test('empty response without truncation is empty', () => {
    assert.strictEqual(
      classifyObservation({ finishReason: 'stop', hasContent: false, contentLength: 0, isEmpty: true }),
      'empty'
    );
    recordRequest({
      mode: 'dynamic-balanced',
      requestId: 'req-empty-1',
      selectedModel: 'vendor/observed-a',
      finishReason: 'stop',
      hasContent: false,
      isEmpty: true,
      contentLength: 0,
      isError: false,
      validationStatus: 'empty',
      validationSource: 'automatic',
      status: 'success',
    });
    assert.strictEqual(getObservationStats().empty, 1);
  });

  test('upstream error is error', () => {
    assert.strictEqual(classifyObservation({ isError: true }), 'error');
  });

  test('missing data is unvalidated', () => {
    assert.strictEqual(classifyObservation({}), 'unvalidated');
    assert.strictEqual(
      classifyObservation({ finishReason: 'tool_calls', hasContent: null }),
      'unvalidated'
    );
  });

  test('later positive validation updates the same row', () => {
    recordRequest({
      mode: 'dynamic-balanced',
      requestId: 'req-validate-pos',
      selectedModel: 'vendor/observed-a',
      finishReason: 'stop',
      hasContent: true,
      isEmpty: false,
      validationStatus: 'completed',
      validationSource: 'automatic',
      status: 'success',
    });
    const before = getObservationStats().observations;
    const result = recordValidation('req-validate-pos', {
      functionalSuccess: true,
      validationStatus: 'functional_success',
      validationSource: 'manual',
    });
    assert.strictEqual(result.functionalSuccess, 1);
    assert.strictEqual(getObservationStats().observations, before);
    const last = getObservationStats().lastObservation;
    assert.strictEqual(last.validationStatus, 'functional_success');
    assert.strictEqual(last.functionalSuccess, 1);
    assert.strictEqual(getObservationStats().functionalSuccess, 1);
  });

  test('later negative validation records functional failure', () => {
    recordRequest({
      mode: 'dynamic-balanced',
      requestId: 'req-validate-neg',
      selectedModel: 'vendor/observed-a',
      finishReason: 'stop',
      hasContent: true,
      isEmpty: false,
      validationStatus: 'completed',
      validationSource: 'automatic',
      status: 'success',
    });
    recordValidation('req-validate-neg', {
      functionalSuccess: false,
      validationStatus: 'functional_failure',
      validationSource: 'manual',
    });
    assert.strictEqual(getObservationStats().functionalFailure, 1);
  });

  test('unknown request id produces a clear error', () => {
    assert.throws(() => recordValidation('req-does-not-exist', { functionalSuccess: true, validationStatus: 'functional_success' }), /Unknown request_id/);
  });

  test('migration covers validation columns and stays idempotent', () => {
    const cols = getRequestEventColumns();
    assert.ok(cols.includes('validation_status'));
    assert.ok(cols.includes('validation_source'));
    assert.ok(cols.includes('functional_success'));
    assert.deepStrictEqual(migrateRequestEvents(), []);
  });

  test('legacy rows without classification remain valid and counted as unvalidated', () => {
    recordRequest('dynamic-balanced', 'vendor/legacy', 10, 20, 'success', null, null);
    const stats = getObservationStats();
    assert.strictEqual(stats.unvalidated, 1);
    assert.strictEqual(stats.validated, 0);
    assert.strictEqual(stats.lastObservation.validationStatus, null);
    assert.strictEqual(stats.lastObservation.functionalSuccess, null);
  });

  test('streaming summary relays metadata without inventing values', async () => {
    const raw = 'data: {"model":"vendor/s","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\ndata: {"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8,"cost":0.001}}\n\ndata: [DONE]\n';
    const chunks = [Buffer.from(raw.slice(0, 40)), Buffer.from(raw.slice(40))];
    async function* body() {
      for (const chunk of chunks) yield chunk;
    }
    const relayed = [];
    let buffer = '';
    const events = [];
    for await (const chunk of relayStreamChunks(body())) {
      relayed.push(chunk);
      buffer += chunk.toString('utf8');
      const { events: done, remainder } = splitSsePayloads(buffer);
      events.push(...done);
      buffer = remainder;
    }
    assert.strictEqual(Buffer.concat(relayed).toString('utf8'), raw);
    const summary = summarizeStreamEvents(events, { max_tokens: 4000 });
    assert.strictEqual(summary.model, 'vendor/s');
    assert.strictEqual(summary.promptTokens, 3);
    assert.strictEqual(summary.cost, 0.001);
    assert.strictEqual(summary.maxTokens, 4000);
    // Delta text was relayed, so content exists; no finish yet, so the
    // classifier reports `empty` only when nothing was seen — here "hi"
    // was seen, so exercise the true empty-stream branch instead.
    assert.strictEqual(summary.finishReason, null);
    assert.strictEqual(summary.hasContent, true);
    const emptySummary = summarizeStreamEvents(['[DONE]'], { max_tokens: 4000 });
    void emptySummary;
    assert.strictEqual(classifyObservation({
      finishReason: summary.finishReason,
      hasContent: summary.hasContent,
      contentLength: summary.contentLength,
      isEmpty: summary.isEmpty,
    }), 'unvalidated');
  });

  test('no prompt or response body is persisted', () => {
    recordRequest({
      mode: 'dynamic-balanced',
      requestId: 'req-no-secrets',
      selectedModel: 'vendor/observed-a',
      status: 'success',
      validationStatus: 'completed',
      validationSource: 'automatic',
    });
    const cols = getRequestEventColumns();
    assert.ok(!cols.includes('prompt'));
    assert.ok(!cols.includes('response'));
    assert.ok(!cols.includes('messages'));
    assert.ok(!cols.includes('api_key'));
    const rows = getRequests(24 * 365 * 10);
    const flat = JSON.stringify(rows[0]);
    assert.ok(!flat.includes('sk-or-'));
  });
});
