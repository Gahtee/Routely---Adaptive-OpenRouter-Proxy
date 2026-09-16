import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { applyBalancedPriceCaps, selectModel } from '../selector.js';
import { getBalancedPriceCaps } from '../config.js';

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

// ~$0.50 in / $0.80 out per 1M — comfortably under the example caps (1 / 5).
const cheapOk = textModel({
  id: 'vendor/cheap-ok',
  pricing: { prompt: '0.0000005', completion: '0.0000008' },
  benchmarks: { artificial_analysis: { coding_index: 70, intelligence_index: 72 } },
});

// ~$2.00 in / $6.00 out per 1M — mirrors the observed qwen/qwen3.8-max-0902
// selection (over a 1 / 5 cap on both legs).
const pricey = textModel({
  id: 'vendor/pricey-max',
  pricing: { prompt: '0.000002', completion: '0.000006' },
  benchmarks: { artificial_analysis: { coding_index: 95, intelligence_index: 97 } },
});

// Exactly $1.00 in / $5.00 out per 1M — boundary must be accepted (>) not (>=).
const boundary = textModel({
  id: 'vendor/at-cap',
  pricing: { prompt: '0.000001', completion: '0.000005' },
  benchmarks: { artificial_analysis: { coding_index: 71, intelligence_index: 73 } },
});

const batchModel = textModel({
  id: 'google/gemini-3.8-flash:batch',
  pricing: { prompt: '0.000000005', completion: '0.00000001' },
  benchmarks: { artificial_analysis: { coding_index: 99, intelligence_index: 99 } },
});

const savedInput = process.env.BALANCED_MAX_INPUT_PRICE;
const savedOutput = process.env.BALANCED_MAX_OUTPUT_PRICE;

function setCaps(input, output) {
  if (input == null) delete process.env.BALANCED_MAX_INPUT_PRICE;
  else process.env.BALANCED_MAX_INPUT_PRICE = String(input);
  if (output == null) delete process.env.BALANCED_MAX_OUTPUT_PRICE;
  else process.env.BALANCED_MAX_OUTPUT_PRICE = String(output);
}

beforeEach(() => { setCaps(null, null); });
afterEach(() => {
  if (savedInput === undefined) delete process.env.BALANCED_MAX_INPUT_PRICE;
  else process.env.BALANCED_MAX_INPUT_PRICE = savedInput;
  if (savedOutput === undefined) delete process.env.BALANCED_MAX_OUTPUT_PRICE;
  else process.env.BALANCED_MAX_OUTPUT_PRICE = savedOutput;
});

describe('dynamic-balanced configurable price caps', () => {
  test('model below the cap can participate', () => {
    const { models, priceDiscardedCount } = applyBalancedPriceCaps(
      [cheapOk], { maxInputPrice: 1, maxOutputPrice: 5 }
    );
    assert.strictEqual(models.length, 1);
    assert.strictEqual(priceDiscardedCount, 0);
  });

  test('model above the cap is discarded with a reason', () => {
    const { models, priceDiscarded, priceDiscardedCount } = applyBalancedPriceCaps(
      [pricey], { maxInputPrice: 1, maxOutputPrice: 5 }
    );
    assert.strictEqual(models.length, 0);
    assert.strictEqual(priceDiscardedCount, 1);
    assert.strictEqual(priceDiscarded[0].model, pricey.id);
    assert.match(priceDiscarded[0].reason, /over-price-cap/);
  });

  test('model exactly at the cap is accepted', () => {
    const { models } = applyBalancedPriceCaps(
      [boundary], { maxInputPrice: 1, maxOutputPrice: 5 }
    );
    assert.strictEqual(models.length, 1);
  });

  test('absence of caps keeps current behavior (nothing discarded)', () => {
    setCaps(null, null);
    assert.deepStrictEqual(getBalancedPriceCaps(), { maxInputPrice: null, maxOutputPrice: null });
    const selection = selectModel([pricey, cheapOk], 'dynamic-balanced', {});
    assert.ok(['vendor/pricey-max', 'vendor/cheap-ok'].includes(selection.model));
    assert.strictEqual(selection.priceDiscardedCount, 0);
  });

  test('caps filter before scoring: pricey benchmark cannot win', () => {
    setCaps(1, 5);
    const selection = selectModel([pricey, cheapOk], 'dynamic-balanced', {});
    assert.strictEqual(selection.model, cheapOk.id);
    assert.strictEqual(selection.maxInputPrice, 1);
    assert.strictEqual(selection.maxOutputPrice, 5);
    assert.strictEqual(selection.priceDiscardedCount, 1);
    assert.ok(selection.discarded.some(d => d.model === pricey.id && /over-price-cap/.test(d.reason)));
  });

  test('no candidate within caps returns a clear price-limit error', () => {
    setCaps(0.01, 0.01);
    assert.throws(
      () => selectModel([pricey, cheapOk], 'dynamic-balanced', {}),
      /within configured price limits/
    );
  });

  test(':batch models remain excluded even with caps set', () => {
    setCaps(100, 100);
    const selection = selectModel([batchModel, cheapOk], 'dynamic-balanced', {});
    assert.strictEqual(selection.model, cheapOk.id);
    assert.ok(selection.discarded.some(d => d.model === batchModel.id && /batch/i.test(d.reason)));
  });

  test('other modes are unaffected by balanced caps', () => {
    // Fixtures must also satisfy dynamic-cheap's static config.json filter
    // (max $0.5/M in/out, coding >= 50): the point is only that the
    // BALANCED_* caps do not leak into the other modes.
    const cheapA = textModel({
      id: 'vendor/cheap-a',
      pricing: { prompt: '0.0000004', completion: '0.0000004' },
      benchmarks: { artificial_analysis: { coding_index: 70, intelligence_index: 72 } },
    });
    const cheapB = textModel({
      id: 'vendor/cheap-b',
      pricing: { prompt: '0.00000045', completion: '0.00000045' },
      benchmarks: { artificial_analysis: { coding_index: 60, intelligence_index: 65 } },
    });
    setCaps(0.000001, 0.000001); // absurdly low: balanced would fail
    assert.throws(() => selectModel([cheapA, cheapB], 'dynamic-balanced', {}), /price limits/);
    const cheap = selectModel([cheapA, cheapB], 'dynamic-cheap', {});
    assert.strictEqual(cheap.model, cheapA.id);
    const auto = selectModel([cheapA, cheapB], 'dynamic-auto', {});
    assert.strictEqual(auto.model, 'openrouter/auto');
  });
});
