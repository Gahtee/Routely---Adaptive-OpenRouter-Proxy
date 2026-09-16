import { config, env, defaultWeights } from './config.js';

const MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models';
const CHAT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

let catalogCache = null;
let catalogTimestamp = 0;

export function getCatalog() {
  return catalogCache;
}

export function getCatalogTimestamp() {
  return catalogTimestamp;
}

export function isCatalogFresh() {
  const age = Date.now() - catalogTimestamp;
  return age < config.catalog.refreshIntervalSeconds * 1000;
}

export async function fetchCatalog() {
  const headers = {
    'Authorization': `Bearer ${env.openRouterApiKey}`,
    'Content-Type': 'application/json',
  };

  if (env.openRouterApiKey) {
    headers['HTTP-Referer'] = 'http://localhost:4000';
    headers['X-OpenRouter-Title'] = 'Dynamic Router Proxy';
  }

  const response = await fetch(MODELS_ENDPOINT, { headers });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch catalog: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  
  catalogCache = data.data;
  catalogTimestamp = Date.now();
  
  return data.data;
}

export async function refreshCatalog() {
  return fetchCatalog();
}

export function isModelFree(model) {
  const promptPrice = parseFloat(model.pricing?.prompt || 0);
  const completionPrice = parseFloat(model.pricing?.completion || 0);
  return promptPrice === 0 && completionPrice === 0;
}

// ---------------------------------------------------------------------------
// Eligibility: explicit compatibility stage for /v1/chat/completions.
// A model must be usable through the normal chat-completions endpoint.
// This proxy does NOT implement the Batch API (/api/beta/batches), so any
// Batch-only model (generic `:batch` suffix) is never eligible.
// Uses only catalog/API data — no external scraping.
// ---------------------------------------------------------------------------
export function isBatchOnlyModel(model) {
  return typeof model?.id === 'string' && model.id.endsWith(':batch');
}

export function getEligibility(model, request = {}) {
  if (!model || typeof model.id !== 'string' || model.id.length === 0) {
    return { eligible: false, reason: 'missing-model-id' };
  }

  // 1. Batch-only models require the Batch API, not /v1/chat/completions.
  if (isBatchOnlyModel(model)) {
    return { eligible: false, reason: 'batch-only: requires Batch API (/api/beta/batches), not /v1/chat/completions' };
  }

  // 2. Expired / disabled / deprecated models.
  const now = Date.now();
  for (const key of ['deprecated', 'expired', 'disabled', 'sunset', 'retired']) {
    if (model[key] === true) {
      return { eligible: false, reason: `model-flagged-${key}` };
    }
  }
  for (const key of ['expires_at', 'expire_at', 'sunset_at', 'deprecation_date', 'deprecated_at', 'expiresAt', 'sunsetAt']) {
    const ts = Date.parse(model[key]);
    if (!Number.isNaN(ts) && ts <= now) {
      return { eligible: false, reason: 'model-expired' };
    }
  }

  // 3. No valid pricing data.
  if (model.pricing == null || typeof model.pricing !== 'object') {
    return { eligible: false, reason: 'missing-pricing' };
  }
  const prompt = parseFloat(model.pricing.prompt);
  const completion = parseFloat(model.pricing.completion);
  const promptValid = model.pricing.prompt === undefined || (!Number.isNaN(prompt) && prompt >= 0);
  const completionValid = model.pricing.completion === undefined || (!Number.isNaN(completion) && completion >= 0);
  if (!promptValid || !completionValid) {
    return { eligible: false, reason: 'invalid-pricing' };
  }
  if (Number.isNaN(prompt) && Number.isNaN(completion)) {
    return { eligible: false, reason: 'invalid-pricing' };
  }

  // 4. Must support textual chat requests.
  const arch = model.architecture || {};
  if (typeof arch.modality === 'string' && !arch.modality.includes('text')) {
    return { eligible: false, reason: `incompatible-modality: ${arch.modality}` };
  }
  if (Array.isArray(arch.input_modalities) && !arch.input_modalities.includes('text')) {
    return { eligible: false, reason: 'incompatible-input-modality' };
  }
  if (Array.isArray(arch.output_modalities) && !arch.output_modalities.includes('text')) {
    return { eligible: false, reason: 'incompatible-output-modality' };
  }

  // 5. Must support capabilities required by the request, when applicable.
  if (request.requireTools && !model.supported_parameters?.includes('tools')) {
    return { eligible: false, reason: 'missing-tools-support' };
  }
  if (request.requireToolChoice && !model.supported_parameters?.includes('tool_choice')) {
    return { eligible: false, reason: 'missing-tool_choice-support' };
  }

  return { eligible: true, reason: null };
}

export function filterEligibleModels(models, request = {}) {
  const eligible = [];
  const discarded = [];
  for (const model of models || []) {
    const { eligible: ok, reason } = getEligibility(model, request);
    if (ok) {
      eligible.push(model);
    } else {
      discarded.push({ model: model?.id ?? null, reason });
    }
  }
  return { eligible, discarded };
}

export function filterModels(models, options = {}) {
  const {
    minContext,
    maxInputPrice,
    maxOutputPrice,
    requireTools,
    requireCoding,
    minCodingIndex,
    includeFreeModels = false,
    blockedModels = [],
    allowedModels = [],
  } = options;

  return models.filter(model => {
    if (!includeFreeModels && isModelFree(model)) {
      return false;
    }

    if (blockedModels.some(bm => model.id === bm || model.id.startsWith(bm + '/'))) {
      return false;
    }

    if (allowedModels.length > 0) {
      if (!allowedModels.some(am => model.id === am || model.id.startsWith(am + '/'))) {
        return false;
      }
    }

    if (minContext && (model.context_length || 0) < minContext) {
      return false;
    }

    const promptPrice = parseFloat(model.pricing?.prompt || 0) * 1_000_000;
    const completionPrice = parseFloat(model.pricing?.completion || 0) * 1_000_000;

    if (maxInputPrice !== undefined && promptPrice > maxInputPrice) {
      return false;
    }

    if (maxOutputPrice !== undefined && completionPrice > maxOutputPrice) {
      return false;
    }

    if (requireTools && !model.supported_parameters?.includes('tools')) {
      return false;
    }

    if (minCodingIndex !== undefined && minCodingIndex !== null) {
      const codingIndex = model.benchmarks?.artificial_analysis?.coding_index;
      if ((codingIndex || 0) < minCodingIndex) {
        return false;
      }
    }

    return true;
  });
}

export function getCheapestModel(models) {
  if (!models || models.length === 0) return null;
  return models.reduce((cheapest, current) => {
    const currentPrompt = parseFloat(current.pricing?.prompt || 0);
    const currentCompletion = parseFloat(current.pricing?.completion || 0);
    const cheapestPrompt = parseFloat(cheapest.pricing?.prompt || 0);
    const cheapestCompletion = parseFloat(cheapest.pricing?.completion || 0);
    const currentCost = currentPrompt + currentCompletion;
    const cheapestCost = cheapestPrompt + cheapestCompletion;
    return currentCost < cheapestCost ? current : cheapest;
  });
}

export function getFreeModels(models) {
  if (!models) return [];
  return models.filter(isModelFree);
}

export function scoreModel(model, weights = defaultWeights) {
  const promptPrice = parseFloat(model.pricing?.prompt || 0) * 1_000_000;
  const completionPrice = parseFloat(model.pricing?.completion || 0) * 1_000_000;
  const aa = model.benchmarks?.artificial_analysis || {};
  const codingIndex = aa.coding_index ?? aa.codingIndex ?? 0;
  const agenticIndex =
    aa.agentic_index ?? aa.agenticIndex ??
    aa.intelligence_index ?? aa.intelligenceIndex ?? 0;
  const context = model.context_length || 0;
  const params = model.supported_parameters || [];
  const hasTools = params.includes('tools') ? 1 : 0;
  const hasToolChoice = params.includes('tool_choice') ? 1 : 0;
  const toolsScore = hasTools && hasToolChoice ? 1 : hasTools ? 0.7 : 0;
  const hasReasoning =
    params.includes('reasoning') ||
    params.includes('include_reasoning') ||
    params.includes('reasoning_effort');
  const reasoningScore = hasReasoning ? 1 : 0;

  const normalizedPriceScore = 1 - (promptPrice / 100);
  const normalizedCompletionScore = 1 - (completionPrice / 200);
  const normalizedCodingScore = codingIndex / 100;
  const normalizedAgenticScore = agenticIndex / 100;
  const normalizedContextScore = Math.min(context / 200000, 1);

  const score = (
    weights.inputPriceWeight * normalizedPriceScore +
    weights.outputPriceWeight * normalizedCompletionScore +
    weights.qualityWeight * normalizedAgenticScore +
    weights.contextWeight * normalizedContextScore +
    (weights.codingIndexWeight ?? 0) * normalizedCodingScore +
    (weights.agenticWeight ?? 0) * normalizedAgenticScore +
    (weights.toolsWeight ?? 0) * toolsScore +
    (weights.reasoningWeight ?? 0) * reasoningScore
  );

  return {
    model,
    score,
    details: {
      promptPrice,
      completionPrice,
      codingIndex,
      agenticIndex,
      context,
      hasTools: Boolean(hasTools),
      hasToolChoice: Boolean(hasToolChoice),
      hasReasoning,
      normalized: {
        price: normalizedPriceScore,
        completion: normalizedCompletionScore,
        coding: normalizedCodingScore,
        agentic: normalizedAgenticScore,
        context: normalizedContextScore,
        tools: toolsScore,
        reasoning: reasoningScore,
      },
    },
  };
}

export function getBestBalancedModel(models, weights = defaultWeights) {
  if (!models || models.length === 0) return null;

  const scoredModels = models.map(model => scoreModel(model, weights));
  scoredModels.sort((a, b) => b.score - a.score);

  return {
    model: scoredModels[0].model,
    score: scoredModels[0].score,
    candidates: scoredModels.slice(0, 5).map(s => ({
      model: s.model.id,
      score: s.score,
      reason: getScoreReason(s),
    })),
  };
}

function getScoreReason(scored) {
  const { details } = scored;
  const reasons = [];

  if (details.normalized.price > 0.9) reasons.push('very cheap');
  if (details.normalized.coding > 0.7) reasons.push('strong coding capability');
  if (details.normalized.agentic > 0.7) reasons.push('strong agentic capability');
  if (details.normalized.context > 0.5) reasons.push('good context window');
  if (details.hasTools) reasons.push('tools support');
  if (details.hasReasoning) reasons.push('reasoning support');

  return reasons.length > 0 ? reasons.join(', ') : 'balanced performance';
}

export function formatPrice(priceInUSDPerToken) {
  const priceInUSDPerMillion = parseFloat(priceInUSDPerToken || 0) * 1_000_000;
  return `$${priceInUSDPerMillion.toFixed(4)}/M`;
}

export default {
  fetchCatalog,
  refreshCatalog,
  getCatalog,
  getCatalogTimestamp,
  isCatalogFresh,
  filterModels,
  filterEligibleModels,
  getEligibility,
  isBatchOnlyModel,
  getCheapestModel,
  getFreeModels,
  isModelFree,
  scoreModel,
  getBestBalancedModel,
  formatPrice,
};
