import { test, describe } from 'node:test';
import assert from 'node:assert';
import { filterModels, getCheapestModel, scoreModel } from '../openrouter-client.js';

const mockCatalog = [
  {
    id: 'anthropic/claude-3-5-sonnet',
    name: 'Claude 3.5 Sonnet',
    context_length: 200000,
    pricing: { prompt: '0.000003', completion: '0.000015' },
    supported_parameters: ['tools', 'temperature', 'max_tokens'],
    benchmarks: { artificial_analysis: { coding_index: 85, intelligence_index: 90 } },
  },
  {
    id: 'deepseek/deepseek-coder-v2',
    name: 'DeepSeek Coder V2',
    context_length: 128000,
    pricing: { prompt: '0.000001', completion: '0.000002' },
    supported_parameters: ['tools', 'temperature', 'max_tokens'],
    benchmarks: { artificial_analysis: { coding_index: 78, intelligence_index: 75 } },
  },
  {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    context_length: 128000,
    pricing: { prompt: '0.000005', completion: '0.000015' },
    supported_parameters: ['tools', 'temperature', 'max_tokens'],
    benchmarks: { artificial_analysis: { coding_index: 88, intelligence_index: 92 } },
  },
  {
    id: 'google/gemini-1.5-pro',
    name: 'Gemini 1.5 Pro',
    context_length: 1000000,
    pricing: { prompt: '0.000002', completion: '0.000006' },
    supported_parameters: ['tools', 'temperature', 'max_tokens'],
    benchmarks: { artificial_analysis: { coding_index: 72, intelligence_index: 78 } },
  },
];

describe('openrouter-client', () => {
  test('should filter models by context', () => {
    const filtered = filterModels(mockCatalog, { minContext: 100000 });
    assert.strictEqual(filtered.length, 4);
  });

  test('should filter models by tools support', () => {
    const filtered = filterModels(mockCatalog, { requireTools: true });
    assert.strictEqual(filtered.length, 4);
  });

  test('should filter models by price', () => {
    const filtered = filterModels(mockCatalog, { maxInputPrice: 3 });
    assert.strictEqual(filtered.length, 3);
  });

  test('should get cheapest model', () => {
    const cheapest = getCheapestModel(mockCatalog);
    assert.strictEqual(cheapest.id, 'deepseek/deepseek-coder-v2');
  });

  test('should score models', () => {
    const scored = scoreModel(mockCatalog[0]);
    assert.ok(typeof scored.score === 'number');
    assert.ok(scored.score > 0);
  });
});
