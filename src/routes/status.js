import express from 'express';
import { config, getBalancedPriceCaps, getHistoryConfig } from '../config.js';
import {
  fetchCatalog,
  getCatalog,
  getCatalogTimestamp,
  isCatalogFresh
} from '../openrouter-client.js';
import { getLastSelections, getRequests, getPriceHistory, getObservationStats, getObservationRows } from '../database.js';
import { buildModelStats, computeCostReference } from '../history.js';

const router = express.Router();
let lastSelections = {
  'dynamic-free': null,
  'dynamic-cheap': null,
  'dynamic-balanced': null,
  'dynamic-auto': null,
};

export function setLastSelection(mode, selection) {
  lastSelections[mode] = selection;
}

router.get('/status', (req, res) => {
  const catalog = getCatalog();
  const catalogTimestamp = getCatalogTimestamp();
  const lastUpdate = catalog ? new Date().toLocaleString() : 'Not yet loaded';
  
  res.json({
    catalog: {
      models: catalog?.length || 0,
      lastUpdate: catalogTimestamp ? new Date(catalogTimestamp).toISOString() : null,
      nextUpdate: catalog
        ? new Date(Date.now() + config.catalog.refreshIntervalSeconds * 1000).toISOString()
        : null,
    },
    balanced: {
      // Optional USD-per-1M-tokens caps from BALANCED_MAX_INPUT_PRICE /
      // BALANCED_MAX_OUTPUT_PRICE. null = no limit.
      ...getBalancedPriceCaps(),
    },
    modes: {
      'dynamic-free': lastSelections['dynamic-free'],
      'dynamic-cheap': lastSelections['dynamic-cheap'],
      'dynamic-balanced': lastSelections['dynamic-balanced'],
      'dynamic-auto': lastSelections['dynamic-auto'],
    },
  });
});

router.get('/models/selected', (req, res) => {
  res.json(lastSelections);
});

router.get('/history', (req, res) => {
  const { limit = 50 } = req.query;
  res.json({
    selections: getLastSelections(parseInt(limit)),
    requests: getRequests(24),
  });
});

router.get('/price-history/:modelId', (req, res) => {
  const { modelId } = req.params;
  const { days = 7 } = req.query;
  res.json({
    model: modelId,
    history: getPriceHistory(modelId, parseInt(days)),
  });
});

// Counts-only execution-observation diagnostics. Follows the existing admin
// pattern (no prompts, completions, or secrets are stored or returned).
// Optional ?byModel=1 adds per-model aggregates used by the history layer.
router.get('/admin/observations', (req, res) => {
  const stats = getObservationStats();
  if (req.query.byModel !== '1') {
    res.json(stats);
    return;
  }
  const historyConfig = getHistoryConfig();
  const rows = getObservationRows({ mode: 'dynamic-balanced' });
  const byModel = new Map();
  for (const row of rows) {
    if (!row.selected_model) continue;
    if (!byModel.has(row.selected_model)) byModel.set(row.selected_model, []);
    byModel.get(row.selected_model).push(row);
  }
  const models = [];
  for (const [model, modelRows] of byModel.entries()) {
    const s = buildModelStats(modelRows, {
      minFunctionalObservations: historyConfig.minFunctionalObservations,
    });
    models.push({
      model,
      observations: s.observationCount,
      completed: s.completedCount,
      truncated: s.truncatedCount,
      errors: s.errorCount,
      empty: s.emptyCount,
      functionalSuccess: s.functionalSuccessCount,
      functionalFailure: s.functionalFailureCount,
      validated: s.validatedCount,
      completionRate: s.completionRate,
      truncatedRate: s.truncatedRate,
      errorRate: s.errorRate,
      emptyRate: s.emptyRate,
      functionalSuccessRate: s.functionalSuccessRate,
      reasoningShare: s.reasoningShare,
      meanCost: s.meanCost,
      medianCost: s.medianCost,
      costPerCompleted: s.costPerCompleted,
      totalCost: s.totalCost,
      totalTokens: s.totalTokens,
    });
  }
  models.sort((a, b) => b.observations - a.observations);
  res.json({
    ...stats,
    costReference: computeCostReference(models.map((m) => ({ costPerCompleted: m.costPerCompleted }))),
    models,
  });
});

router.post('/admin/refresh', async (req, res) => {
  try {
    const { force = false } = req.body || {};

    if (!force && isCatalogFresh()) {
      return res.json({
        message: 'Catalog is fresh',
        timestamp: new Date(getCatalogTimestamp()).toISOString(),
        fresh: true,
      });
    }

    const catalog = await fetchCatalog();
    res.json({
      message: 'Catalog refreshed successfully',
      models: catalog.length,
      timestamp: new Date().toISOString(),
      fresh: true,
    });
  } catch (error) {
    res.status(500).json({
      message: 'Failed to refresh catalog',
      error: error.message,
      fresh: false,
    });
  }
});

export default router;
