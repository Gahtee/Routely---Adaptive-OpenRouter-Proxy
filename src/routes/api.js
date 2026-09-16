import express from 'express';
import { env } from '../config.js';
import { fetchCatalog, getCatalog, formatPrice } from '../openrouter-client.js';

const router = express.Router();

// GET /v1/models - Return virtual models
router.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id: 'dynamic-free',
        object: 'model',
        created: Date.now(),
        owned_by: 'dynamic-router',
        name: 'Dynamic Free',
        description: 'Automatically selects the best free model',
      },
      {
        id: 'dynamic-cheap',
        object: 'model',
        created: Date.now(),
        owned_by: 'dynamic-router',
        name: 'Dynamic Cheapest',
        description: 'Automatically selects the cheapest compatible paid model',
      },
      {
        id: 'dynamic-balanced',
        object: 'model',
        created: Date.now(),
        owned_by: 'dynamic-router',
        name: 'Dynamic Balanced',
        description: 'Selects best cost/capability ratio model',
      },
      {
        id: 'dynamic-auto',
        object: 'model',
        created: Date.now(),
        owned_by: 'dynamic-router',
        name: 'Dynamic Auto',
        description: 'Uses OpenRouter official Auto Router',
      },
    ],
  });
});

// GET /v1/catalog - Return actual OpenRouter models
router.get('/v1/catalog', async (req, res) => {
  try {
    const catalog = getCatalog();
    if (!catalog || catalog.length === 0) {
      return res.status(404).json({
        error: 'Catalog not loaded',
        message: 'Please use POST /admin/refresh to load the catalog first',
      });
    }
    res.json({
      object: 'list',
      data: catalog.map(model => ({
        id: model.id,
        object: 'model',
        created: model.created,
        name: model.name,
        context_length: model.context_length,
        pricing: {
          input: formatPrice(model.pricing?.prompt),
          output: formatPrice(model.pricing?.completion),
        },
        is_free: parseFloat(model.pricing?.prompt || 0) === 0 && parseFloat(model.pricing?.completion || 0) === 0,
        supports_tools: model.supported_parameters?.includes('tools'),
      })),
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get catalog',
      message: error.message,
    });
  }
});

// GET /health - Health check
router.get('/health', (req, res) => {
  const catalog = getCatalog();
  res.json({
    status: 'ok',
    catalog_loaded: !!catalog,
    catalog_size: catalog?.length || 0,
    timestamp: new Date().toISOString(),
  });
});

export default router;
