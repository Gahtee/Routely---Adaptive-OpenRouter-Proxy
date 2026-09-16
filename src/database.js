import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { DB_PATH } from './config.js';

let db = null;
let activeDbPath = DB_PATH;

async function init(dbPath = DB_PATH) {
  const SQL = await initSqlJs();
  activeDbPath = dbPath || DB_PATH;

  if (existsSync(dbPath)) {
    const binaryArray = readFileSync(dbPath);
    db = new SQL.Database(binaryArray);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS model_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id TEXT NOT NULL,
      prompt_price REAL,
      completion_price REAL,
      context_length INTEGER,
      timestamp INTEGER NOT NULL,
      discount REAL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS selection_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      mode TEXT NOT NULL,
      selected_model TEXT,
      input_price REAL,
      output_price REAL,
      score REAL,
      reason TEXT,
      request_id TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS request_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      mode TEXT,
      selected_model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      status TEXT,
      error TEXT,
      cost REAL
    )
  `);

  // Idempotent migration: adds execution-observation columns to
  // request_events without touching existing data. Safe to run on every
  // init/restart; already-present columns are skipped.
  migrateRequestEvents();

  save();
}

function save(dbPath = activeDbPath) {
  if (!db) return;
  const binaryArray = db.export();
  writeFileSync(dbPath, Buffer.from(binaryArray));
}

function selectAll(sql, params = []) {
  if (!db) return [];
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    return rows;
  } finally {
    stmt.free();
  }
}

// ---------------------------------------------------------------------------
// request_events migration (idempotent).
// New observation columns for execution telemetry. Existing rows keep NULL
// in the new columns; no historical data is modified.
// ---------------------------------------------------------------------------
const REQUEST_EVENT_COLUMNS = [
  { name: 'request_id', ddl: 'TEXT' },
  { name: 'provider', ddl: 'TEXT' },
  { name: 'max_tokens', ddl: 'INTEGER' },
  { name: 'reasoning_tokens', ddl: 'INTEGER' },
  { name: 'total_tokens', ddl: 'INTEGER' },
  { name: 'finish_reason', ddl: 'TEXT' },
  { name: 'native_finish_reason', ddl: 'TEXT' },
  { name: 'content_length', ddl: 'INTEGER' },
  { name: 'has_content', ddl: 'INTEGER' },
  { name: 'is_error', ddl: 'INTEGER' },
  { name: 'is_empty', ddl: 'INTEGER' },
  // Classification of the observed outcome, separate from raw upstream facts.
  // See VALIDATION_STATUSES in observation.js for the documented vocabulary.
  { name: 'validation_status', ddl: 'TEXT' },
  { name: 'validation_source', ddl: 'TEXT' },
  { name: 'functional_success', ddl: 'INTEGER' },
];

export function getRequestEventColumns() {
  if (!db) return [];
  return selectAll('PRAGMA table_info(request_events)').map((row) => row.name);
}

export function migrateRequestEvents() {
  if (!db) return [];
  const existing = new Set(getRequestEventColumns());
  const added = [];
  for (const col of REQUEST_EVENT_COLUMNS) {
    if (!existing.has(col.name)) {
      db.run(`ALTER TABLE request_events ADD COLUMN ${col.name} ${col.ddl}`);
      added.push(col.name);
    }
  }
  if (added.length > 0) save();
  return added;
}

function rowsToValues(rows) {
  if (!rows || rows.length === 0) return [];
  const keys = Object.keys(rows[0]);
  return rows.map(row => keys.map(k => row[k]));
}

// Price history functions
export function recordPrice(modelId, promptPrice, completionPrice, contextLength, discount = 0) {
  if (!db) return;
  db.run(
    'INSERT INTO model_prices (model_id, prompt_price, completion_price, context_length, timestamp, discount) VALUES (?, ?, ?, ?, ?, ?)',
    [modelId, promptPrice, completionPrice, contextLength, Date.now(), discount]
  );
  save();
}

export function getRecentPrices(modelId, hours = 24) {
  const since = Date.now() - hours * 60 * 60 * 1000;
  return rowsToValues(selectAll(
    'SELECT * FROM model_prices WHERE model_id = ? AND timestamp > ? ORDER BY timestamp DESC',
    [modelId, since]
  ));
}

export function getPriceHistory(modelId, days = 7) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  return rowsToValues(selectAll(
    'SELECT * FROM model_prices WHERE model_id = ? AND timestamp > ? ORDER BY timestamp ASC',
    [modelId, since]
  ));
}

// Selection events functions
export function recordSelection(mode, selectedModel, inputPrice, outputPrice, score, reason, requestId) {
  if (!db) return;
  db.run(
    'INSERT INTO selection_events (timestamp, mode, selected_model, input_price, output_price, score, reason, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [Date.now(), mode, selectedModel, inputPrice, outputPrice, score, reason, requestId]
  );
  save();
}

export function getLastSelections(limit = 10) {
  return rowsToValues(selectAll(
    'SELECT * FROM selection_events ORDER BY timestamp DESC LIMIT ?',
    [limit]
  ));
}

export function getSelectionsByMode(mode) {
  return rowsToValues(selectAll(
    'SELECT * FROM selection_events WHERE mode = ? ORDER BY timestamp DESC',
    [mode]
  ));
}

// Request events functions.
//
// recordRequest accepts either the legacy positional argument list or a
// single details object. The object form carries execution-observation
// fields; unknown/absent upstream values must be passed as null (never
// coerced to zero by this layer).
export function recordRequest(mode, selectedModel, inputTokens, outputTokens, status, error, cost, details = {}) {
  if (!db) return;
  if (
    mode !== null &&
    typeof mode === 'object' &&
    selectedModel === undefined
  ) {
    details = mode;
    mode = details.mode ?? null;
    selectedModel = details.selectedModel ?? details.selected_model ?? null;
    inputTokens = details.inputTokens ?? details.input_tokens ?? details.promptTokens ?? details.prompt_tokens ?? null;
    outputTokens = details.outputTokens ?? details.output_tokens ?? details.completionTokens ?? details.completion_tokens ?? null;
    status = details.status ?? null;
    error = details.error ?? null;
    cost = details.cost ?? null;
  }
  const d = details || {};
  const toIntOrNull = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? Math.trunc(num) : null;
  };
  const toTextOrNull = (value) => {
    if (value === null || value === undefined) return null;
    return String(value);
  };
  const toRealOrNull = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };
  const toBoolIntOrNull = (value) => {
    if (value === null || value === undefined) return null;
    return value ? 1 : 0;
  };

  db.run(
    `INSERT INTO request_events (
      timestamp, mode, selected_model, input_tokens, output_tokens, status, error, cost,
      request_id, provider, max_tokens, reasoning_tokens, total_tokens,
      finish_reason, native_finish_reason, content_length, has_content, is_error, is_empty,
      validation_status, validation_source, functional_success
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Date.now(),
      toTextOrNull(mode),
      toTextOrNull(selectedModel),
      toIntOrNull(inputTokens),
      toIntOrNull(outputTokens),
      toTextOrNull(status),
      toTextOrNull(error),
      toRealOrNull(cost),
      toTextOrNull(d.requestId ?? d.request_id ?? null),
      toTextOrNull(d.provider ?? null),
      toIntOrNull(d.maxTokens ?? d.max_tokens ?? null),
      // reasoning_tokens: null when upstream does not report it (never 0).
      d.reasoningTokens === undefined && d.reasoning_tokens === undefined
        ? null
        : toIntOrNull(d.reasoningTokens ?? d.reasoning_tokens ?? null),
      toIntOrNull(d.totalTokens ?? d.total_tokens ?? null),
      toTextOrNull(d.finishReason ?? d.finish_reason ?? null),
      toTextOrNull(d.nativeFinishReason ?? d.native_finish_reason ?? null),
      toIntOrNull(d.contentLength ?? d.content_length ?? null),
      toBoolIntOrNull(d.hasContent ?? d.has_content ?? null),
      toBoolIntOrNull(d.isError ?? d.is_error ?? null),
      toBoolIntOrNull(d.isEmpty ?? d.is_empty ?? null),
      toTextOrNull(d.validationStatus ?? d.validation_status ?? null),
      toTextOrNull(d.validationSource ?? d.validation_source ?? null),
      d.functionalSuccess === undefined && d.functional_success === undefined
        ? null
        : toBoolIntOrNull(d.functionalSuccess ?? d.functional_success ?? null),
    ]
  );
  save();
}

// Later, explicit functional validation of an existing observation. Updates
// the row matched by request_id in place; never inserts a second row.
// Only an explicit validation may set functional_success (1/0) and the
// functional_* statuses. Throws when the request_id is unknown.
export function recordValidation(requestId, validation = {}) {
  if (!db) throw new Error('Database is not initialized.');
  const id = requestId == null ? null : String(requestId);
  if (!id) throw new Error('recordValidation requires a request_id.');
  const status = validation.validationStatus ?? validation.validation_status ?? null;
  const source = validation.validationSource ?? validation.validation_source ?? 'manual';
  const success = validation.functionalSuccess ?? validation.functional_success ?? null;
  const allowed = new Set([
    'unvalidated',
    'completed',
    'truncated',
    'error',
    'empty',
    'functional_success',
    'functional_failure',
  ]);
  if (status !== null && !allowed.has(String(status))) {
    throw new Error(`Unknown validation_status: ${status}`);
  }
  if (success !== null && success !== 0 && success !== 1 && success !== true && success !== false) {
    throw new Error('functionalSuccess must be 1/0, true/false, or null.');
  }
  if (
    (String(status) === 'functional_success' && success !== 1 && success !== true) ||
    (String(status) === 'functional_failure' && success !== 0 && success !== false)
  ) {
    throw new Error('functional_* status must agree with functionalSuccess.');
  }
  if (
    (success === 1 || success === true) &&
    status !== null &&
    String(status) !== 'functional_success'
  ) {
    throw new Error('functionalSuccess=1 requires validation_status=functional_success.');
  }
  if (
    (success === 0 || success === false) &&
    status !== null &&
    String(status) !== 'functional_failure'
  ) {
    throw new Error('functionalSuccess=0 requires validation_status=functional_failure.');
  }

  const stmt = db.prepare('SELECT COUNT(*) AS n FROM request_events WHERE request_id = ?');
  let count = 0;
  try {
    stmt.bind([id]);
    if (stmt.step()) count = stmt.getAsObject()?.n ?? 0;
  } finally {
    stmt.free();
  }
  if (!count) throw new Error(`Unknown request_id: ${id}`);

  const successInt = success === null || success === undefined ? null : (success ? 1 : 0);
  db.run(
    `UPDATE request_events
     SET validation_status = ?, validation_source = ?, functional_success = ?
     WHERE request_id = ?`,
    [status === null ? null : String(status), source === null ? null : String(source), successInt, id]
  );
  save();
  return { requestId: id, validationStatus: status, validationSource: source, functionalSuccess: successInt };
}

export function getRequests(hours = 24) {
  const since = Date.now() - hours * 60 * 60 * 1000;
  return rowsToValues(selectAll(
    'SELECT * FROM request_events WHERE timestamp > ? ORDER BY timestamp DESC',
    [since]
  ));
}

// Raw observation rows (snake_case objects, counts only metadata) for the
// adaptive-history layer. Optional filters scope to real, identifiable
// observations; callers build per-model aggregates from the result.
// No prompts, completions, or secrets are stored, so none can leak here.
export function getObservationRows({ mode = null, modelId = null, limit = 10000 } = {}) {
  if (!db) return [];
  const clauses = [];
  const params = [];
  if (mode !== null && mode !== undefined) {
    clauses.push('mode = ?');
    params.push(mode);
  }
  if (modelId !== null && modelId !== undefined) {
    clauses.push('selected_model = ?');
    params.push(modelId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const lim = Number.isFinite(Number(limit)) ? Math.max(Number(limit), 0) : 10000;
  return selectAll(
    `SELECT selected_model, mode, timestamp, request_id, provider, max_tokens,
            input_tokens, output_tokens, reasoning_tokens, total_tokens, cost,
            finish_reason, native_finish_reason, content_length, has_content,
            is_error, is_empty, status, validation_status, validation_source,
            functional_success
     FROM request_events ${where} ORDER BY id ASC LIMIT ${lim}`,
    params
  );
}

// Per-model aggregate statistics (same shape as buildModelStats, computed
// in SQL for production use). NULL metrics mean "not enough data", never 0.
export function getModelHistoryStats({ mode = 'dynamic-balanced', limit = 10000 } = {}) {
  if (!db) return [];
  const rows = getObservationRows({ mode, limit });
  const byModel = new Map();
  for (const row of rows) {
    if (!row.selected_model) continue;
    if (!byModel.has(row.selected_model)) byModel.set(row.selected_model, []);
    byModel.get(row.selected_model).push(row);
  }
  // Aggregates are computed by history.buildModelStats in the selector so
  // SQL and tests share one implementation; this helper only groups rows.
  return [...byModel.entries()].map(([model, modelRows]) => ({ model, rows: modelRows }));
}

// Aggregate observation diagnostics. Counts only; never returns prompts,
// completions, or secrets (those are not stored by this layer at all).
export function getObservationStats() {
  if (!db) {
    return {
      observations: 0,
      modelsObserved: 0,
      withCost: 0,
      withReasoningTokens: 0,
      withFinishReason: 0,
      validated: 0,
      functionalSuccess: 0,
      functionalFailure: 0,
      completed: 0,
      truncated: 0,
      empty: 0,
      errors: 0,
      unvalidated: 0,
      lastObservation: null,
    };
  }
  const countWhere = (predicate) =>
    selectAll(`SELECT COUNT(*) AS n FROM request_events WHERE ${predicate}`)[0]?.n ?? 0;
  const total = selectAll('SELECT COUNT(*) AS n FROM request_events')[0]?.n ?? 0;
  const models = selectAll('SELECT COUNT(DISTINCT selected_model) AS n FROM request_events WHERE selected_model IS NOT NULL')[0]?.n ?? 0;
  const withCost = countWhere('cost IS NOT NULL');
  const withReasoning = countWhere('reasoning_tokens IS NOT NULL');
  const withFinish = countWhere('finish_reason IS NOT NULL');
  const completed = countWhere(`validation_status = 'completed'`);
  const truncated = countWhere(`validation_status = 'truncated'`);
  const empty = countWhere(`validation_status = 'empty'`);
  const errors = countWhere(`validation_status = 'error'`);
  const functionalSuccess = countWhere('functional_success = 1');
  const functionalFailure = countWhere('functional_success = 0');
  // Validated = any explicit outcome beyond the raw facts: either a
  // classified automatic status or an explicit functional validation.
  const validated = countWhere(`validation_status IS NOT NULL AND validation_status != 'unvalidated'`);
  // Unvalidated = no classification yet (NULL or explicit unvalidated).
  const unvalidated = countWhere(`validation_status IS NULL OR validation_status = 'unvalidated'`);
  const lastRows = selectAll(
    `SELECT timestamp, mode, selected_model, request_id, provider, max_tokens,
            input_tokens, output_tokens, reasoning_tokens, total_tokens, cost,
            finish_reason, native_finish_reason, content_length, has_content,
            is_error, is_empty, status, validation_status, validation_source,
            functional_success
     FROM request_events ORDER BY id DESC LIMIT 1`
  );
  const last = lastRows[0] || null;
  return {
    observations: total,
    modelsObserved: models,
    withCost,
    withReasoningTokens: withReasoning,
    withFinishReason: withFinish,
    validated,
    functionalSuccess,
    functionalFailure,
    completed,
    truncated,
    empty,
    errors,
    unvalidated,
    lastObservation: last
      ? {
          timestamp: last.timestamp,
          isoTimestamp: typeof last.timestamp === 'number' ? new Date(last.timestamp).toISOString() : null,
          mode: last.mode,
          selectedModel: last.selected_model,
          requestId: last.request_id,
          provider: last.provider,
          maxTokens: last.max_tokens,
          inputTokens: last.input_tokens,
          outputTokens: last.output_tokens,
          reasoningTokens: last.reasoning_tokens,
          totalTokens: last.total_tokens,
          cost: last.cost,
          finishReason: last.finish_reason,
          nativeFinishReason: last.native_finish_reason,
          contentLength: last.content_length,
          hasContent: last.has_content,
          isError: last.is_error,
          isEmpty: last.is_empty,
          status: last.status,
          validationStatus: last.validation_status,
          validationSource: last.validation_source,
          functionalSuccess: last.functional_success,
        }
      : null,
  };
}

export function close() {
  if (db) {
    save();
    db.close();
    db = null;
    activeDbPath = DB_PATH;
  }
}

// Test-only helper: resets the in-memory handle without touching the file.
export function __resetForTests() {
  if (db) {
    try { db.close(); } catch {}
    db = null;
  }
  activeDbPath = DB_PATH;
}

export default { init, close, recordPrice, getRecentPrices, getPriceHistory,
  recordSelection, getLastSelections, getSelectionsByMode,
  recordRequest, recordValidation, getRequests, getObservationRows,
  getModelHistoryStats, getObservationStats,
  migrateRequestEvents, getRequestEventColumns, __resetForTests
};
