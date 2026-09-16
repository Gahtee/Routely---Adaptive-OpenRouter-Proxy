import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  filterEligibleModels,
  getEligibility,
  isBatchOnlyModel,
  getBestBalancedModel,
} from '../openrouter-client.js';
import { selectModel } from '../selector.js';
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

// Regression scenario from the bug report: a Batch-only model is cheaper and
// higher-benchmark than any normal model, so without an eligibility stage it
// would win the balanced ranking and then fail on /v1/chat/completions.
const batchModel = textModel({
  id: 'google/gemini-3.8-flash:batch',
  pricing: { prompt: '0.000000005', completion: '0.00000001' },
  context_length: 1000000,
  benchmarks: { artificial_analysis: { coding_index: 95, intelligence_index: 97 } },
});

const normalModel = textModel({
  id: 'inclusionai/ling-3.0-flash',
  pricing: { prompt: '0.000000021', completion: '0.000000063' },
  context_length: 262144,
  benchmarks: { artificial_analysis: { coding_index: 70, intelligence_index: 72 } },
});

const freeModel = textModel({
  id: 'stealth/union-alpha',
  pricing: { prompt: '0', completion: '0' },
  context_length: 128000,
  benchmarks: { artificial_analysis: { coding_index: 65, intelligence_index: 68 } },
});

describe('dynamic-balanced batch-only exclusion', () => {
  test('isBatchOnlyModel matches any generic :batch suffix', () => {
    assert.strictEqual(isBatchOnlyModel({ id: 'foo:batch' }), true);
    assert.strictEqual(isBatchOnlyModel({ id: 'google/gemini-3.8-flash:batch' }), true);
    assert.strictEqual(isBatchOnlyModel({ id: 'inclusionai/ling-3.0-flash' }), false);
    assert.strictEqual(isBatchOnlyModel({ id: 'openai/gpt-4o' }), false);
  });

  test('batch-only model is ineligible before scoring', () => {
    const result = getEligibility(batchModel, {});
    assert.strictEqual(result.eligible, false);
    assert.match(result.reason, /batch/i);
  });

  test('filterEligibleModels discards batch models with a reason', () => {
    const { eligible, discarded } = filterEligibleModels([batchModel, normalModel], {});
    assert.ok(!eligible.some(m => m.id === batchModel.id));
    assert.ok(eligible.some(m => m.id === normalModel.id));
    const entry = discarded.find(d => d.model === batchModel.id);
    assert.ok(entry, 'expected discard entry for the batch model');
    assert.ok(entry.reason && entry.reason.length > 0);
  });

  test('a generic foo:batch model never enters the balanced ranking', () => {
    const fooBatch = textModel({
      id: 'foo:batch',
      pricing: { prompt: '0.000000001', completion: '0.000000001' },
      benchmarks: { artificial_analysis: { coding_index: 99, intelligence_index: 99 } },
    });
    const { eligible } = filterEligibleModels([fooBatch, normalModel], {});
    const ranked = getBestBalancedModel(eligible, defaultWeights);
    assert.ok(!ranked.model.id.endsWith(':batch'));
    assert.ok(!ranked.candidates.some(c => c.model.endsWith(':batch')));
  });

  test('dynamic-balanced never selects a :batch model; normal equivalent wins', () => {
    const selection = selectModel([batchModel, normalModel], 'dynamic-balanced', {});
    assert.strictEqual(selection.mode, 'dynamic-balanced');
    assert.ok(!selection.model.endsWith(':batch'), `selected ${selection.model}`);
    assert.strictEqual(selection.model, normalModel.id);
    // explicability fields preserved
    assert.ok(selection.price?.input);
    assert.ok(selection.price?.output);
    assert.ok(selection.context);
    assert.strictEqual(typeof selection.score, 'number');
    assert.ok(Array.isArray(selection.candidates) && selection.candidates.length > 0);
    assert.ok(selection.reason);
    // discard reason kept for diagnosis
    assert.ok(Array.isArray(selection.discarded));
    assert.ok(selection.discarded.some(d => d.model === batchModel.id));
  });

  test('dynamic-cheap still excludes free models', () => {
    const selection = selectModel([freeModel, normalModel], 'dynamic-cheap', {});
    assert.strictEqual(selection.model, normalModel.id);
    assert.strictEqual(selection.isFree, false);
    assert.strictEqual(selection.price.input, '$0.0210/M');
    assert.strictEqual(selection.price.output, '$0.0630/M');
    assert.strictEqual(selection.context, 262144);
  });

  test('dynamic-free still selects a zero-cost model', () => {
    const selection = selectModel([freeModel, normalModel], 'dynamic-free', {});
    assert.strictEqual(selection.model, freeModel.id);
    assert.strictEqual(selection.isFree, true);
  });

  test('dynamic-auto still delegates to openrouter/auto', () => {
    const selection = selectModel([batchModel, normalModel], 'dynamic-auto', {});
    assert.strictEqual(selection.model, 'openrouter/auto');
  });
});
