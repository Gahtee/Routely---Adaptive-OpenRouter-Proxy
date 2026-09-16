import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import db, {
  __resetForTests,
  getObservationRows,
  getModelHistoryStats,
  recordRequest,
} from '../database.js';
import {
  buildModelStats,
  calculateHistoricalAdjustment,
  computeCostReference,
} from '../history.js';
import { selectModel } from '../selector.js';
import { scoreModel } from '../openrouter-client.js';
import { defaultWeights, getHistoryConfig } from '../config.js';

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

function row(overrides = {}) {
  return {
    selected_model: 'vendor/x',
    mode: 'dynamic-balanced',
    validation_status: 'completed',
    functional_success: null,
    cost: 0.002,
    input_tokens: 100,
    output_tokens: 200,
    reasoning_tokens: 40,
    total_tokens: 300,
    ...overrides,
  };
}

const CFG = {
  minObservations: 20,
  minFunctionalObservations: 3,
  minAdjustment: 0.8,
  maxAdjustment: 1.05,
  truncatedWeight: 0.1,
  errorWeight: 0.15,
  emptyWeight: 0.1,
  reasoningWeight: 0.05,
  costWeight: 0.1,
  functionalSuccessWeight: 0.05,
  functionalFailureWeight: 0.1,
};

const savedEnv = { ...process.env };
beforeEach(async () => {
  __resetForTests();
  const dir = mkdtempSync(join(tmpdir(), 'router-history-'));
  await db.init(join(dir, 'test.db'));
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
});

describe('adaptive history', () => {
  test('1. model without history gets adjustment 1.0', () => {
    const adj = calculateHistoricalAdjustment(buildModelStats([]), CFG, null);
    assert.strictEqual(adj.adjustment, 1);
    assert.strictEqual(adj.confidence, 0);
  });

  test('2. a single observation has small influence', () => {
    const stats = buildModelStats([row({ validation_status: 'truncated' })]);
    const full = calculateHistoricalAdjustment(stats, CFG, 0.002);
    assert.strictEqual(full.confidence, 0.05);
    assert.ok(full.adjustment > 0.99 && full.adjustment < 1);
    assert.strictEqual(stats.truncatedRate, 1);
  });

  test('3. enough history reaches confidence 1.0', () => {
    const stats = buildModelStats(Array.from({ length: 20 }, () => row()), { minFunctionalObservations: 3 });
    const adj = calculateHistoricalAdjustment(stats, CFG, 0.002);
    assert.strictEqual(adj.confidence, 1);
    assert.strictEqual(stats.completionRate, 1);
  });

  test('4. high length rate penalizes', () => {
    const stats = buildModelStats(Array.from({ length: 20 }, () => row({ validation_status: 'truncated', cost: 0.002 })), { minFunctionalObservations: 3 });
    const adj = calculateHistoricalAdjustment(stats, CFG, 0.002);
    assert.ok(adj.adjustment < 1);
    assert.ok(adj.adjustment >= 0.8);
  });

  test('5. errors penalize', () => {
    const stats = buildModelStats(Array.from({ length: 20 }, () => row({ validation_status: 'error' })), { minFunctionalObservations: 3 });
    const adj = calculateHistoricalAdjustment(stats, CFG, 0.002);
    assert.ok(adj.adjustment < 1);
  });

  test('6. empty responses penalize', () => {
    const stats = buildModelStats(Array.from({ length: 20 }, () => row({ validation_status: 'empty' })), { minFunctionalObservations: 3 });
    const adj = calculateHistoricalAdjustment(stats, CFG, 0.002);
    assert.ok(adj.adjustment < 1);
  });

  test('7. excessive reasoning can penalize', () => {
    const heavy = buildModelStats(
      Array.from({ length: 20 }, () => row({ output_tokens: 1000, reasoning_tokens: 990 })),
      { minFunctionalObservations: 3 }
    );
    const light = buildModelStats(
      Array.from({ length: 20 }, () => row({ output_tokens: 1000, reasoning_tokens: 10 })),
      { minFunctionalObservations: 3 }
    );
    const heavyAdj = calculateHistoricalAdjustment(heavy, CFG, 0.002);
    const lightAdj = calculateHistoricalAdjustment(light, CFG, 0.002);
    assert.ok(heavy.reasoningShare > 0.9);
    assert.ok(heavyAdj.adjustment < lightAdj.adjustment);
  });

  test('8. cost per completed is computed from completed rows', () => {
    const stats = buildModelStats([
      row({ validation_status: 'completed', cost: 0.002 }),
      row({ validation_status: 'functional_success', cost: 0.004 }),
    ]);
    assert.strictEqual(stats.completedCostObservations, 2);
    assert.strictEqual(stats.costPerCompleted, 0.003);
  });

  test('9. length, error and empty never enter cost_per_completed', () => {
    const stats = buildModelStats([
      row({ validation_status: 'truncated', cost: 0.01 }),
      row({ validation_status: 'error', cost: 0.02 }),
      row({ validation_status: 'empty', cost: 0.03 }),
    ]);
    assert.strictEqual(stats.costPerCompleted, null);
    assert.strictEqual(stats.completedCostObservations, 0);
  });

  test('10. stop never becomes functional success', () => {
    const stats = buildModelStats([row({ validation_status: 'completed', functional_success: null })]);
    assert.strictEqual(stats.functionalSuccessCount, 0);
    assert.strictEqual(stats.functionalSuccessRate, null);
    assert.strictEqual(stats.completedCount, 1);
  });

  test('11. functional_success=1 counts when available', () => {
    const stats = buildModelStats(
      Array.from({ length: 3 }, () => row({ validation_status: 'functional_success', functional_success: 1 })),
      { minFunctionalObservations: 3 }
    );
    assert.strictEqual(stats.functionalSuccessRate, 1);
    const adj = calculateHistoricalAdjustment(stats, CFG, 0.002);
    assert.ok(adj.adjustment > 1 && adj.adjustment <= 1.05);
  });

  test('12. functional_failure=0 counts when available', () => {
    const stats = buildModelStats(
      Array.from({ length: 3 }, () => row({ validation_status: 'functional_failure', functional_success: 0 })),
      { minFunctionalObservations: 3 }
    );
    assert.strictEqual(stats.functionalFailureRate, 1);
    const adj = calculateHistoricalAdjustment(stats, CFG, 0.002);
    assert.ok(adj.adjustment < 1);
  });

  test('13. model without history gets no penalty', () => {
    const stats = buildModelStats([]);
    const adj = calculateHistoricalAdjustment(stats, CFG, 0.002);
    assert.strictEqual(adj.adjustment, 1);
    assert.strictEqual(adj.effectivePenalty, 0);
  });

  test('14. history does not change eligibility', () => {
    const cheap = textModel({ id: 'vendor/cheap-h' });
    const batchRich = textModel({
      id: 'vendor/batch-h:batch',
      pricing: { prompt: '0.000000001', completion: '0.000000001' },
      benchmarks: { artificial_analysis: { coding_index: 99, intelligence_index: 99 } },
    });
    for (let i = 0; i < 20; i += 1) {
      recordRequest({ mode: 'dynamic-balanced', selectedModel: 'vendor/cheap-h', validationStatus: 'error', validationSource: 'automatic', status: 'success' });
    }
    const selection = selectModel([batchRich, cheap], 'dynamic-balanced', {});
    assert.strictEqual(selection.model, 'vendor/cheap-h');
  });

  test('15. history does not change price caps', () => {
    process.env.BALANCED_MAX_INPUT_PRICE = '0.01';
    process.env.BALANCED_MAX_OUTPUT_PRICE = '0.01';
    const pricey = textModel({ id: 'vendor/pricey-h', pricing: { prompt: '0.000002', completion: '0.000006' } });
    assert.throws(() => selectModel([pricey], 'dynamic-balanced', {}), /price limits/);
  });

  test('16. cheap, free and auto modes are unchanged', () => {
    const cheapModel = textModel({ id: 'vendor/cheap-mode', pricing: { prompt: '0.0000004', completion: '0.0000004' } });
    const freeModel = textModel({ id: 'vendor/free-mode', pricing: { prompt: '0', completion: '0' }, context_length: 128000 });
    const cheap = selectModel([cheapModel, freeModel], 'dynamic-cheap', {});
    assert.strictEqual(cheap.model, 'vendor/cheap-mode');
    assert.strictEqual(cheap.historicalAdjustment, undefined);
    const free = selectModel([cheapModel, freeModel], 'dynamic-free', {});
    assert.strictEqual(free.model, 'vendor/free-mode');
    const auto = selectModel([cheapModel], 'dynamic-auto', {});
    assert.strictEqual(auto.model, 'openrouter/auto');
  });

  test('17. catalog price changes affect static score, not stored history', () => {
    const base = textModel({ id: 'vendor/price-move' });
    const before = scoreModel(base, defaultWeights).score;
    const pricey = textModel({ id: 'vendor/price-move', pricing: { prompt: '0.000002', completion: '0.000006' } });
    const after = scoreModel(pricey, defaultWeights).score;
    assert.ok(after < before);
    recordRequest({ mode: 'dynamic-balanced', selectedModel: 'vendor/price-move', validationStatus: 'completed', validationSource: 'automatic', cost: 0.002, status: 'success' });
    const rows = getObservationRows({ modelId: 'vendor/price-move' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].cost, 0.002);
  });

  test('18. adjustment stays within configured bounds', () => {
    const worst = buildModelStats(
      Array.from({ length: 20 }, () => row({ validation_status: 'error', output_tokens: 100, reasoning_tokens: 99, cost: 99 })),
      { minFunctionalObservations: 3 }
    );
    const adj = calculateHistoricalAdjustment(worst, CFG, 0.000001);
    assert.ok(adj.adjustment >= 0.8 && adj.adjustment <= 1.05);
  });

  test('19. same input is deterministic', () => {
    const stats = buildModelStats([
      row({ validation_status: 'completed', cost: 0.002 }),
      row({ validation_status: 'truncated', cost: 0.003 }),
    ]);
    const first = calculateHistoricalAdjustment(stats, CFG, 0.002);
    const second = calculateHistoricalAdjustment(stats, CFG, 0.002);
    assert.deepStrictEqual(first, second);
  });

  test('20. empty database works', () => {
    assert.deepStrictEqual(getObservationRows(), []);
    assert.deepStrictEqual(getModelHistoryStats(), []);
    const stats = buildModelStats(getObservationRows({ modelId: 'vendor/none' }));
    assert.strictEqual(stats.observationCount, 0);
    assert.strictEqual(stats.costPerCompleted, null);
    const adj = calculateHistoricalAdjustment(stats, getHistoryConfig(), computeCostReference([]));
    assert.strictEqual(adj.adjustment, 1);
  });
});
