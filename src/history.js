// Pure adaptive-history math for dynamic-balanced.
//
// No DB access here (database.js supplies row aggregates) and no scoring
// logic changes: this module only computes a bounded multiplier applied on
// top of the unchanged static score. All functions are deterministic.

export const COMPLETED_STATUSES = Object.freeze(['completed', 'functional_success']);

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Aggregate raw request_events rows (snake_case columns, as returned by the
// DB layer) into per-model statistics. Only the rows passed in are counted;
// callers scope by mode/model. Missing values stay NULL and are excluded
// from the aggregates that need them (NULL reasoning_tokens is never 0).
export function buildModelStats(rows, options = {}) {
  const minFunctional = options.minFunctionalObservations ?? 3;
  const list = Array.isArray(rows) ? rows : [];

  let completedCount = 0;
  let truncatedCount = 0;
  let errorCount = 0;
  let emptyCount = 0;
  let functionalSuccessCount = 0;
  let functionalFailureCount = 0;
  let validatedCount = 0;

  const costs = [];
  let totalCost = 0;
  let totalTokensSum = 0;
  let tokenObservations = 0;
  let reasoningSum = 0;
  let reasoningBasisTokens = 0;
  let completedCostSum = 0;
  let completedCostObservations = 0;

  for (const row of list) {
    const status = row.validation_status ?? row.validationStatus ?? null;
    if (status === 'completed' || status === 'functional_success') completedCount += 1;
    if (status === 'truncated') truncatedCount += 1;
    if (status === 'error') errorCount += 1;
    if (status === 'empty') emptyCount += 1;
    if (status !== null && status !== 'unvalidated') validatedCount += 1;

    const func = row.functional_success ?? row.functionalSuccess ?? null;
    if (func === 1) functionalSuccessCount += 1;
    else if (func === 0) functionalFailureCount += 1;

    const cost = toNumberOrNull(row.cost);
    if (cost !== null) {
      costs.push(cost);
      totalCost += cost;
    }

    const total = toNumberOrNull(row.total_tokens ?? row.totalTokens);
    const input = toNumberOrNull(row.input_tokens ?? row.inputTokens);
    const output = toNumberOrNull(row.output_tokens ?? row.outputTokens);
    const effectiveTotal = total ?? (input !== null && output !== null ? input + output : null);
    if (effectiveTotal !== null) {
      totalTokensSum += effectiveTotal;
      tokenObservations += 1;
    }

    // reasoning_share uses only rows where BOTH reasoning and completion
    // tokens exist; rows with NULL reasoning are excluded, not zeroed.
    const reasoning = toNumberOrNull(row.reasoning_tokens ?? row.reasoningTokens);
    if (reasoning !== null && output !== null && output > 0) {
      reasoningSum += reasoning;
      reasoningBasisTokens += output;
    }

    // cost_per_completed denominator: ONLY completed / functional_success
    // rows. truncated, error and empty rows never enter, even with cost.
    if ((status === 'completed' || status === 'functional_success') && cost !== null) {
      completedCostSum += cost;
      completedCostObservations += 1;
    }
  }

  const observationCount = list.length;
  const rate = (count) => (observationCount === 0 ? null : count / observationCount);
  const functionalTotal = functionalSuccessCount + functionalFailureCount;
  const hasEnoughFunctional = functionalTotal >= minFunctional;

  return {
    observationCount,
    completedCount,
    truncatedCount,
    errorCount,
    emptyCount,
    functionalSuccessCount,
    functionalFailureCount,
    validatedCount,
    completionRate: rate(completedCount),
    truncatedRate: rate(truncatedCount),
    errorRate: rate(errorCount),
    emptyRate: rate(emptyCount),
    // Explicit functional validation only; `completed` (stop) never lands
    // here. NULL until minFunctionalObservations explicit validations exist.
    functionalSuccessRate: hasEnoughFunctional ? functionalSuccessCount / functionalTotal : null,
    functionalFailureRate: hasEnoughFunctional ? functionalFailureCount / functionalTotal : null,
    totalCost: costs.length > 0 ? totalCost : null,
    meanCost: costs.length > 0 ? totalCost / costs.length : null,
    medianCost: median(costs),
    costObservations: costs.length,
    totalTokens: tokenObservations > 0 ? totalTokensSum : null,
    meanTokens: tokenObservations > 0 ? totalTokensSum / tokenObservations : null,
    tokenObservations,
    totalReasoningTokens: reasoningBasisTokens > 0 ? reasoningSum : null,
    reasoningBasisTokens,
    reasoningShare: reasoningBasisTokens > 0 ? reasoningSum / reasoningBasisTokens : null,
    completedCostTotal: completedCostObservations > 0 ? completedCostSum : null,
    completedCostObservations,
    costPerCompleted: completedCostObservations > 0 ? completedCostSum / completedCostObservations : null,
  };
}

// Robust cost reference across the currently eligible candidates: the median
// of their cost_per_completed values. Candidates without a computable
// cost_per_completed do not participate. NULL when nobody has history.
export function computeCostReference(statsList) {
  const values = (Array.isArray(statsList) ? statsList : [])
    .map((s) => s?.costPerCompleted)
    .filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0)
    .map((v) => Number(v));
  return median(values);
}

// Bounded historical multiplier over the static score.
//
//   confidence        = min(observationCount / minObservations, 1)
//   rawPenalty        = wT*truncatedRate + wE*errorRate + wEm*emptyRate
//                     + wR*reasoningShare + wC*costPenalty
//                     + wFF*functionalFailureRate
//   rawBonus          = wFB*functionalSuccessRate
//   effectivePenalty  = (rawPenalty - rawBonus) * confidence
//   adjustment        = clamp(1 - effectivePenalty, minAdjustment, maxAdjustment)
//   finalScore        = staticScore * adjustment
//
// Missing metrics contribute 0 (never an artificial penalty). Models with no
// history get confidence 0 and adjustment exactly 1.0.
export function calculateHistoricalAdjustment(stats, historyConfig = {}, costReference = null) {
  const cfg = {
    minObservations: 20,
    minAdjustment: 0.8,
    maxAdjustment: 1.05,
    truncatedWeight: 0.1,
    errorWeight: 0.15,
    emptyWeight: 0.1,
    reasoningWeight: 0.05,
    costWeight: 0.1,
    functionalSuccessWeight: 0.05,
    functionalFailureWeight: 0.1,
    ...historyConfig,
  };
  const count = stats?.observationCount ?? 0;
  const confidence = cfg.minObservations > 0
    ? Math.min(count / cfg.minObservations, 1)
    : (count > 0 ? 1 : 0);

  if (count === 0) {
    return {
      adjustment: 1,
      confidence: 0,
      rawPenalty: 0,
      rawBonus: 0,
      effectivePenalty: 0,
      costPenalty: 0,
      costReference: costReference ?? null,
      observationCount: 0,
    };
  }

  const truncatedRate = stats.truncatedRate ?? 0;
  const errorRate = stats.errorRate ?? 0;
  const emptyRate = stats.emptyRate ?? 0;
  const reasoningShare = stats.reasoningShare ?? 0;

  let costPenalty = 0;
  const cpc = stats.costPerCompleted;
  if (cpc !== null && cpc !== undefined && costReference !== null && costReference !== undefined && costReference > 0) {
    costPenalty = Math.min(Math.max(Number(cpc) / Number(costReference) - 1, 0), 1);
  }

  const functionalFailureRate = stats.functionalFailureRate ?? 0;
  const functionalSuccessRate = stats.functionalSuccessRate ?? 0;

  const rawPenalty =
    cfg.truncatedWeight * truncatedRate +
    cfg.errorWeight * errorRate +
    cfg.emptyWeight * emptyRate +
    cfg.reasoningWeight * reasoningShare +
    cfg.costWeight * costPenalty +
    cfg.functionalFailureWeight * functionalFailureRate;
  const rawBonus = cfg.functionalSuccessWeight * functionalSuccessRate;
  const effectivePenalty = (rawPenalty - rawBonus) * confidence;
  const adjustment = Math.min(Math.max(1 - effectivePenalty, cfg.minAdjustment), cfg.maxAdjustment);

  return {
    adjustment,
    confidence,
    rawPenalty,
    rawBonus,
    effectivePenalty,
    costPenalty,
    costReference: costReference ?? null,
    observationCount: count,
  };
}
