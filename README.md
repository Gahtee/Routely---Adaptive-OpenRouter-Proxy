# Routely — Adaptive OpenRouter Proxy

A local OpenAI-compatible proxy that provides intelligent model selection from OpenRouter. Designed for use with coding agents like Kilo Code and Cline.

## Features

- **dynamic-free**: Automatically selects the best free model
- **dynamic-cheap**: Selects the cheapest compatible paid model
- **dynamic-balanced**: Selects the best cost/capability ratio model
- **dynamic-auto**: Uses OpenRouter's official Auto Router

## Installation

```bash
git clone https://github.com/your-org/routely.git
cd routely
npm install
```

## Configuration

### Environment Variables

Create a `.env` file:

```env
OPENROUTER_API_KEY=your_openrouter_api_key
ROUTER_API_KEY=your_optional_proxy_api_key
PORT=4000
# Optional: price caps for dynamic-balanced only (USD per 1M tokens).
# Unset/empty = no limit. Example: BALANCED_MAX_INPUT_PRICE=1
BALANCED_MAX_INPUT_PRICE=
BALANCED_MAX_OUTPUT_PRICE=
```

### Config File

Edit `config.json`:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 4000
  },
  "catalog": {
    "refreshIntervalSeconds": 300
  },
  "cheap": {
    "minContext": 100000,
    "maxInputPrice": 0.5,
    "maxOutputPrice": 1.0,
    "requireTools": true,
    "minCodingIndex": 50,
    "includeFreeModels": false
  },
  "balanced": {
    "minContext": 100000,
    "maxInputPrice": 2.0,
    "maxOutputPrice": 8.0,
    "requireTools": true,
    "minCodingIndex": 60,
    "includeFreeModels": false
  },
  "auto": {
    "costTier": "low"
  }
}
```

## Running

```bash
# Development
npm run dev

# Production
npm start
```

The server runs at `http://127.0.0.1:4000`

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/status` | GET | Current status and selections |
| `/models/selected` | GET | Last selections by mode |
| `/v1/models` | GET | Virtual models list |
| `/v1/catalog` | GET | Full OpenRouter catalog |
| `/v1/chat/completions` | POST | Chat endpoint |
| `/admin/refresh` | POST | Force catalog refresh |

## Configuration for Kilo Code / Cline

### Kilo Code

```
Provider: OpenAI Compatible
Base URL: http://127.0.0.1:4000/v1
API Key: your_optional_proxy_api_key (optional)
Model: dynamic-free (or dynamic-cheap, dynamic-balanced, dynamic-auto)
```

### Cline

```
API Provider: OpenAI Compatible
Base URL: http://127.0.0.1:4000/v1
API Key: your_optional_proxy_api_key (optional)
Model: dynamic-cheap
```

## Modes Explained

### dynamic-free

Selects from models that are completely free (zero pricing for both input and output tokens).

- Only considers models where input price = $0/M AND output price = $0/M
- Free models are a separate category from promotional/low-cost models
- No price configuration required since all candidates are free
- Best for: Low-cost testing and experimentation

### dynamic-cheap

Selects the cheapest compatible **paid** model based on:
- Minimum context window (default: 100K)
- Maximum input/output prices
- Required tools support
- Minimum coding capability index
- **Excludes free models by default** (`includeFreeModels: false`)

To include free models in this mode, set `includeFreeModels: true` in `config.json`:

```json
{
  "cheap": {
    "includeFreeModels": true
  }
}
```

**Note**: When `includeFreeModels: true`, free models will be selected if they meet all other criteria since they have the lowest possible cost.

### dynamic-balanced

Selects the best cost/capability ratio using a scoring system:
- Input price score
- Output price score  
- Quality (coding capability) score
- Context window score

Weights can be adjusted in `config.json`:

```json
{
  "weights": {
    "inputPriceWeight": 1.0,
    "outputPriceWeight": 1.5,
    "qualityWeight": 0.5,
    "contextWeight": 0.2,
    "codingIndexWeight": 0.8
  }
}
```

#### Optional price caps (env only, `dynamic-balanced` only)

High-capability models stay in the catalog; the caps only exclude them from
`dynamic-balanced` selection when they exceed your budget:

```env
BALANCED_MAX_INPUT_PRICE=1
BALANCED_MAX_OUTPUT_PRICE=5
```

Values are USD per 1M tokens. Unset, empty, or invalid means "no limit"
(current behavior). The cap filter runs after eligibility (including the
`:batch` exclusion) and before scoring, so over-budget models never enter the
ranking. If nothing remains, the request fails with a clear
`within configured price limits` error instead of silently picking a
costlier model. The active caps appear in `GET /status` (`balanced` section)
and in the `dynamic-balanced` selection payload (`maxInputPrice`,
`maxOutputPrice`, `priceDiscardedCount`, plus per-model `discarded` reasons).

### dynamic-auto

Uses OpenRouter's official Auto Router with configurable cost tiers:
- low (cheapest 20%)
- medium (20-40%)
- high (40-60%)
- xhigh (60-80%)
- max (most expensive 20%)

## API Usage

### Get Available Virtual Models

```bash
curl http://127.0.0.1:4000/v1/models
```

### Get Full Catalog (with free model indicators)

```bash
curl http://127.0.0.1:4000/v1/catalog
```

### Chat Completion (Free Mode)

```bash
curl http://127.0.0.1:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dynamic-free",
    "messages": [
      {"role": "user", "content": "Hello"}
    ],
    "stream": true
  }'
```

### Chat Completion (Cheapest Paid Mode)

```bash
curl http://127.0.0.1:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dynamic-cheap",
    "messages": [
      {"role": "user", "content": "Hello"}
    ],
    "stream": false
  }'
```

### Get Status

```bash
curl http://127.0.0.1:4000/status
```

### Force Catalog Refresh

```bash
curl -X POST http://127.0.0.1:4000/admin/refresh
```

## Testing

```bash
npm test
```

## Architecture

```
Kilo/Cline
    ↓
http://127.0.0.1:4000/v1
    ↓
Dynamic Router (Node.js)
    ↓
OpenRouter API
    ↓
Selected Provider/Model
```

## Database

The router uses SQLite to store:
- Model price history
- Selection events
- Request events

## Security

- Server binds to localhost by default
- Optional API key authentication
- No API keys stored in the database
- No complete conversation content stored

## Limitations

- Requires OpenRouter API key for catalog access
- Model selection is based on static criteria, not runtime performance
- Some provider-specific features may not be exposed

## License

MIT
