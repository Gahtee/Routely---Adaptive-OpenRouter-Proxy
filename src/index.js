import express from 'express';
import { env, config } from './config.js';
import { fetchCatalog, getCatalog } from './openrouter-client.js';
import db from './database.js';
import statusRouter from './routes/status.js';
import apiRouter from './routes/api.js';
import chatRouter from './routes/chat.js';

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/v1/models') {
    return next();
  }
  if (env.routerApiKey) {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${env.routerApiKey}`) {
      return res.status(401).json({
        error: {
          code: 'unauthorized',
          message: 'Authentication required',
        },
      });
    }
  }
  next();
});

app.use(statusRouter);
app.use(apiRouter);
app.use(chatRouter);

app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'An unexpected error occurred',
    },
  });
});

async function init() {
  await db.init();
  console.log('[DynamicRouter] Database initialized');

  try {
    console.log('[DynamicRouter] Fetching initial catalog...');
    await fetchCatalog();
    const catalog = getCatalog();
    console.log(`[DynamicRouter] Loaded ${catalog.length} models`);
    console.log(`[DynamicRouter] Catalog will be refreshed every ${config.catalog.refreshIntervalSeconds} seconds`);
  } catch (error) {
    console.error('[DynamicRouter] Failed to fetch catalog:', error.message);
    console.log('[DynamicRouter] Server will start without catalog. Use POST /admin/refresh to load it.');
  }
}

function startRefreshInterval() {
  setInterval(async () => {
    try {
      await fetchCatalog();
      const catalog = getCatalog();
      console.log(`[DynamicRouter] Catalog refreshed: ${catalog.length} models`);
    } catch (error) {
      console.error('[DynamicRouter] Catalog refresh failed:', error.message);
    }
  }, config.catalog.refreshIntervalSeconds * 1000);
}

async function start() {
  await init();
  startRefreshInterval();

  app.listen(env.port, env.host, () => {
    console.log(`[DynamicRouter] Server running at http://${env.host}:${env.port}`);
    console.log('[DynamicRouter] Endpoints:');
    console.log('  GET  /health           - Health check');
    console.log('  GET  /status           - Current status and selections');
    console.log('  GET  /models/selected  - Last selections by mode');
    console.log('  GET  /v1/models        - Virtual models (dynamic-cheap, dynamic-balanced, dynamic-auto)');
    console.log('  GET  /v1/catalog       - Full OpenRouter catalog');
    console.log('  POST /v1/chat/completions - Chat endpoint');
    console.log('  POST /admin/refresh    - Force catalog refresh');
    console.log('\n[DynamicRouter] Configure Kilo/Cline:');
    console.log('  Base URL: http://127.0.0.1:4000/v1');
    console.log('  Model: dynamic-cheap, dynamic-balanced, or dynamic-auto');
  });
}

process.on('SIGINT', () => {
  console.log('[DynamicRouter] Shutting down...');
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[DynamicRouter] Shutting down...');
  db.close();
  process.exit(0);
});

start().catch(err => {
  console.error('[DynamicRouter] Failed to start server:', err);
  process.exit(1);
});
