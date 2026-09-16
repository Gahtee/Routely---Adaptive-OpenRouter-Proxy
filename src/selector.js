import { randomUUID } from 'node:crypto';
import { config, defaultWeights, getBalancedPriceCaps, getHistoryConfig } from './config.js';
import {
  filterModels,
  filterEligibleModels,
  getCheapestModel,
  getFreeModels,
  getBestBalancedModel,
  formatPrice,
  scoreModel
} from './openrouter-client.js';
import { recordSelection, getObservationRows } from './database.js';
import { buildModelStats, calculateHistoricalAdjustment, computeCostReference } from './history.js';

// Internal discard reasons per mode (for diagnosis/debug).
// Exposed in the selection payload as `discarded` without removing any
// existing public field (model, prices, context, score, candidates, reason).
const lastDiscardedByMode = {
  'dynamic-free': [],
  'dynamic-cheap': [],
  'dynamic-balanced': [],
};

export function getLastDiscarded(mode) {
  return lastDiscardedByMode[mode] || [];
}

export function selectModel(catalog, mode, requestInfo = {}) {
  const {
    requireTools = false,
    requireToolChoice = false,
  } = requestInfo;

  switch (mode) {
    case 'dynamic-free':
      return selectFree(catalog, { requireTools, requireToolChoice });

    case 'dynamic-cheap':
      return selectCheapest(catalog, {
        minContext: config.cheap.minContext,
        maxInputPrice: config.cheap.maxInputPrice,
        maxOutputPrice: config.cheap.maxOutputPrice,
        requireTools: config.cheap.requireTools || requireTools,
        minCodingIndex: config.cheap.minCodingIndex,
        includeFreeModels: config.cheap.includeFreeModels,
      }, { requireTools, requireToolChoice });

    case 'dynamic-balanced':
      return selectBalanced(catalog, {
        minContext: config.balanced.minContext,
        maxInputPrice: config.balanced.maxInputPrice,
        maxOutputPrice: config.balanced.maxOutputPrice,
        requireTools: config.balanced.requireTools || requireTools,
        minCodingIndex: config.balanced.minCodingIndex,
        includeFreeModels: config.balanced.includeFreeModels,
      }, { requireTools, requireToolChoice });

    case 'dynamic-auto':
      return selectAuto(catalog);

    default:
      return selectCheapest(catalog);
  }
}

function selectFree(catalog, request = {}) {
  const { eligible, discarded } = filterEligibleModels(catalog, request);
  lastDiscardedByMode['dynamic-free'] = discarded;

  const freeModels = getFreeModels(eligible);

  if (freeModels.length === 0) {
    throw new Error('No free models available at this time.');
  }

  const cheapestFree = getCheapestModel(freeModels);
  const promptPrice = parseFloat(cheapestFree.pricing?.prompt || 0);
  const completionPrice = parseFloat(cheapestFree.pricing?.completion || 0);

  recordSelection(
    'dynamic-free',
    cheapestFree.id,
    0,
    0,
    0,
    'free model with best compatibility',
    null
  );

  return {
    model: cheapestFree.id,
    selectedModel: cheapestFree,
    price: {
      input: 'Free ($0/M)',
      output: 'Free ($0/M)',
    },
    context: cheapestFree.context_length,
    reason: 'free model with best compatibility',
    mode: 'dynamic-free',
    isFree: true,
    discarded,
  };
}

function selectCheapest(catalog, options = {}, request = {}) {
  // Flow: catalog → filter eligibility → filter free/criteria → select cheapest.
  const { eligible, discarded } = filterEligibleModels(catalog, request);
  lastDiscardedByMode['dynamic-cheap'] = discarded;

  const filtered = filterModels(eligible, options);

  if (filtered.length === 0) {
    throw new Error('No compatible models found with current criteria. Try relaxing the constraints.');
  }

  const cheapest = getCheapestModel(filtered);
  const promptPrice = parseFloat(cheapest.pricing?.prompt || 0);
  const completionPrice = parseFloat(cheapest.pricing?.completion || 0);

  recordSelection(
    'dynamic-cheap',
    cheapest.id,
    promptPrice * 1_000_000,
    completionPrice * 1_000_000,
    promptPrice + completionPrice,
    'lowest compatible paid cost',
    null
  );

  return {
    model: cheapest.id,
    selectedModel: cheapest,
    price: {
      input: formatPrice(promptPrice),
      output: formatPrice(completionPrice),
    },
    context: cheapest.context_length,
    reason: 'lowest compatible paid cost',
    mode: 'dynamic-cheap',
    isFree: false,
    discarded,
  };
}

function selectBalanced(catalog, options = {}, request = {}) {
  // Flow: catalog → eligibility filter (incl. batch-only exclusion)
  // → exclude free → exclude models above configured price caps
  // → existing static filter/score → historical stats → bounded adjustment
  // → final score → select. History NEVER reintroduces a filtered-out model.
  const { eligible, discarded } = filterEligibleModels(catalog, request);

  const caps = getBalancedPriceCaps();
  const { models: capped, priceDiscarded, priceDiscardedCount } =
    applyBalancedPriceCaps(eligible, caps);
  const allDiscarded = [...discarded, ...priceDiscarded];
  lastDiscardedByMode['dynamic-balanced'] = allDiscarded;

  // filterModels applies the static config.json price limits as before.
  const filtered = filterModels(capped, options);

  if (filtered.length === 0) {
    if (priceDiscardedCount > 0) {
      const inCap = caps.maxInputPrice != null ? `$${caps.maxInputPrice}/M input` : null;
      const outCap = caps.maxOutputPrice != null ? `$${caps.maxOutputPrice}/M output` : null;
      const capText = [inCap, outCap].filter(Boolean).join(' / ');
      throw new Error(
        `No compatible balanced model within configured price limits (${capText}). ` +
        `${priceDiscardedCount} candidate(s) discarded for exceeding the price cap. ` +
        `Raise BALANCED_MAX_INPUT_PRICE / BALANCED_MAX_OUTPUT_PRICE or unset them to allow costlier models.`
      );
    }
    throw new Error('No compatible models found with current criteria. Try relaxing the constraints.');
  }

  const weights = { ...defaultWeights, ...(config.weights || {}) };
  const historyConfig = getHistoryConfig();

  // Static scores first, exactly as before.
  const scored = filtered.map((model) => scoreModel(model, weights));

  // Historical stats for the currently eligible candidates only.
  let historyByModel = new Map();
  try {
    const rows = getObservationRows({ mode: 'dynamic-balanced' });
    for (const row of rows) {
      if (!row.selected_model) continue;
      if (!historyByModel.has(row.selected_model)) historyByModel.set(row.selected_model, []);
      historyByModel.get(row.selected_model).push(row);
    }
  } catch {
    historyByModel = new Map();
  }
  const statsByModel = new Map();
  for (const { model } of scored) {
    statsByModel.set(
      model.id,
      buildModelStats(historyByModel.get(model.id) || [], {
        minFunctionalObservations: historyConfig.minFunctionalObservations,
      })
    );
  }
  // Cost reference: median of cost_per_completed across candidates that
  // have one. Missing history never creates an artificial penalty.
  const costReference = computeCostReference([...statsByModel.values()]);

  const adjusted = scored.map((entry) => {
    const stats = statsByModel.get(entry.model.id);
    const adj = calculateHistoricalAdjustment(stats, historyConfig, costReference);
    const finalScore = entry.score * adj.adjustment;
    return {
      ...entry,
      staticScore: entry.score,
      historicalAdjustment: adj.adjustment,
      finalScore,
      history: {
        observationCount: stats.observationCount,
        confidence: adj.confidence,
        truncatedRate: stats.truncatedRate,
        errorRate: stats.errorRate,
        emptyRate: stats.emptyRate,
        reasoningShare: stats.reasoningShare,
        costPerCompleted: stats.costPerCompleted,
        functionalSuccessRate: stats.functionalSuccessRate,
        functionalFailureRate: stats.functionalFailureRate,
        costReference,
      },
    };
  });
  adjusted.sort((a, b) => b.finalScore - a.finalScore);

  const winner = adjusted[0];
  const model = winner.model;
  const promptPrice = parseFloat(model.pricing?.prompt || 0);
  const completionPrice = parseFloat(model.pricing?.completion || 0);

  // Correlation id shared with the downstream request_event. Ranking and
  // candidate list still derive from the static score; the adjustment only
  // scales it. `score` keeps the static value for backward compatibility.
  const requestId = randomUUID();

  recordSelection(
    'dynamic-balanced',
    model.id,
    promptPrice * 1_000_000,
    completionPrice * 1_000_000,
    winner.finalScore,
    'best cost/capability ratio',
    requestId
  );

  return {
    model: model.id,
    selectedModel: model,
    price: {
      input: formatPrice(promptPrice),
      output: formatPrice(completionPrice),
    },
    context: model.context_length,
    score: winner.staticScore,
    staticScore: winner.staticScore,
    historicalAdjustment: winner.historicalAdjustment,
    finalScore: winner.finalScore,
    history: winner.history,
    candidates: adjusted.slice(0, 5).map((entry) => ({
      model: entry.model.id,
      score: entry.finalScore,
      staticScore: entry.staticScore,
      historicalAdjustment: entry.historicalAdjustment,
      reason: scoreReason(entry),
    })),
    reason: 'best cost/capability ratio',
    mode: 'dynamic-balanced',
    isFree: false,
    maxInputPrice: caps.maxInputPrice,
    maxOutputPrice: caps.maxOutputPrice,
    priceDiscardedCount,
    discarded: allDiscarded,
    requestId,
  };
}

// Optional USD-per-1M-tokens caps for dynamic-balanced, from
// BALANCED_MAX_INPUT_PRICE / BALANCED_MAX_OUTPUT_PRICE.
// Applied AFTER eligibility (incl. batch-only exclusion) and BEFORE scoring,
// so over-budget models never enter the ranking. Returns models within caps
// plus discard entries with explicit reasons.
export function applyBalancedPriceCaps(models, caps = {}) {
  const { maxInputPrice = null, maxOutputPrice = null } = caps || {};
  if (maxInputPrice == null && maxOutputPrice == null) {
    return { models: models || [], priceDiscarded: [], priceDiscardedCount: 0 };
  }
  const kept = [];
  const priceDiscarded = [];
  for (const model of models || []) {
    const inPerM = parseFloat(model.pricing?.prompt || 0) * 1_000_000;
    const outPerM = parseFloat(model.pricing?.completion || 0) * 1_000_000;
    const overIn = maxInputPrice != null && inPerM > maxInputPrice;
    const overOut = maxOutputPrice != null && outPerM > maxOutputPrice;
    if (overIn || overOut) {
      const parts = [];
      if (overIn) parts.push(`input $${inPerM.toFixed(4)}/M exceeds cap $${maxInputPrice}/M`);
      if (overOut) parts.push(`output $${outPerM.toFixed(4)}/M exceeds cap $${maxOutputPrice}/M`);
      priceDiscarded.push({ model: model?.id ?? null, reason: `over-price-cap: ${parts.join('; ')}` });
    } else {
      kept.push(model);
    }
  }
  return { models: kept, priceDiscarded, priceDiscardedCount: priceDiscarded.length };
}

// Static-only reason text, shared with the adjusted candidate list so the
// human-readable explanation still comes from the unchanged static score.
function scoreReason(entry) {
  const normalized = entry?.details?.normalized;
  if (!normalized) return 'balanced performance';
  const reasons = [];
  if (normalized.price > 0.9) reasons.push('very cheap');
  if (normalized.coding > 0.7) reasons.push('strong coding capability');
  if (normalized.agentic > 0.7) reasons.push('strong agentic capability');
  if (normalized.context > 0.5) reasons.push('good context window');
  if (entry.details.hasTools) reasons.push('tools support');
  if (entry.details.hasReasoning) reasons.push('reasoning support');
  return reasons.length > 0 ? reasons.join(', ') : 'balanced performance';
}

function selectAuto(catalog) {
  const autoConfig = config.auto;

  recordSelection(
    'dynamic-auto',
    null,
    null,
    null,
    null,
    `using OpenRouter Auto Router with tier: ${autoConfig.costTier}`,
    null
  );

  return {
    model: 'openrouter/auto',
    selectedModel: null,
    price: {
      input: 'Auto-determined',
      output: 'Auto-determined',
    },
    context: null,
    reason: `using OpenRouter Auto Router with tier: ${autoConfig.costTier}`,
    mode: 'dynamic-auto',
    costTier: autoConfig.costTier,
    isFree: null,
  };
}

export default selectModel;
