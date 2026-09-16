import { readFileSync } from 'fs';
import { join } from 'path';

const envPath = join(process.cwd(), '.env');
try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: envPath });
} catch (e) {}

const configPath = join(process.cwd(), 'config.json');
export const config = JSON.parse(readFileSync(configPath, 'utf-8'));

export const env = {
  openRouterApiKey: process.env.OPENROUTER_API_KEY,
  routerApiKey: process.env.ROUTER_API_KEY,
  port: parseInt(process.env.PORT) || config.server.port,
  host: process.env.HOST || config.server.host,
  balancedMaxInputPrice: parsePriceCap(process.env.BALANCED_MAX_INPUT_PRICE),
  balancedMaxOutputPrice: parsePriceCap(process.env.BALANCED_MAX_OUTPUT_PRICE),
};

function parsePriceCap(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text === '') return null;
  const num = Number(text);
  if (!Number.isFinite(num) || num < 0) return null;
  return num;
}

// Read live from process.env so tests (and runtime changes) take effect
// without re-importing the module. Values are USD per 1M tokens.
// Returns null when undefined/invalid, meaning "no limit".
export function getBalancedPriceCaps() {
  return {
    maxInputPrice: parsePriceCap(process.env.BALANCED_MAX_INPUT_PRICE),
    maxOutputPrice: parsePriceCap(process.env.BALANCED_MAX_OUTPUT_PRICE),
  };
}

// Adaptive-history configuration for dynamic-balanced. The history layer is
// a bounded multiplier over the static score; none of these values change
// filters, caps, ranking order by themselves, or any other mode.
function parsePositiveNumber(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  if (text === '') return fallback;
  const num = Number(text);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

export const defaultHistoryConfig = {
  // Observations needed for full confidence: confidence = min(n / 20, 1).
  minObservations: 20,
  // Minimum explicit functional validations before functional rates apply.
  minFunctionalObservations: 3,
  // Bounded multiplier range: final = static * adjustment.
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

export function getHistoryConfig() {
  return {
    minObservations: parsePositiveNumber(process.env.HISTORY_MIN_OBSERVATIONS, defaultHistoryConfig.minObservations),
    minFunctionalObservations: parsePositiveNumber(process.env.HISTORY_MIN_FUNCTIONAL_OBSERVATIONS, defaultHistoryConfig.minFunctionalObservations),
    minAdjustment: parsePositiveNumber(process.env.HISTORY_MIN_ADJUSTMENT, defaultHistoryConfig.minAdjustment),
    maxAdjustment: parsePositiveNumber(process.env.HISTORY_MAX_ADJUSTMENT, defaultHistoryConfig.maxAdjustment),
    truncatedWeight: parsePositiveNumber(process.env.HISTORY_TRUNCATED_WEIGHT, defaultHistoryConfig.truncatedWeight),
    errorWeight: parsePositiveNumber(process.env.HISTORY_ERROR_WEIGHT, defaultHistoryConfig.errorWeight),
    emptyWeight: parsePositiveNumber(process.env.HISTORY_EMPTY_WEIGHT, defaultHistoryConfig.emptyWeight),
    reasoningWeight: parsePositiveNumber(process.env.HISTORY_REASONING_WEIGHT, defaultHistoryConfig.reasoningWeight),
    costWeight: parsePositiveNumber(process.env.HISTORY_COST_WEIGHT, defaultHistoryConfig.costWeight),
    functionalSuccessWeight: parsePositiveNumber(process.env.HISTORY_FUNCTIONAL_SUCCESS_WEIGHT, defaultHistoryConfig.functionalSuccessWeight),
    functionalFailureWeight: parsePositiveNumber(process.env.HISTORY_FUNCTIONAL_FAILURE_WEIGHT, defaultHistoryConfig.functionalFailureWeight),
  };
}

export const DB_PATH = join(process.cwd(), 'dynamic-router.db');

export const defaultWeights = {
  inputPriceWeight: 1.0,
  outputPriceWeight: 1.5,
  qualityWeight: 0.5,
  contextWeight: 0.2,
  codingIndexWeight: 0.8,
  agenticWeight: 0.6,
  toolsWeight: 0.4,
  reasoningWeight: 0.3,
};
