import express from 'express';
import { config, env } from '../config.js';
import { getCatalog } from '../openrouter-client.js';
import selectModel from '../selector.js';
import { recordRequest } from '../database.js';
import {
  classifyObservation,
  extractErrorObservation,
  extractObservation,
  newRequestId,
  relayStreamChunks,
  splitSsePayloads,
  summarizeStreamEvents,
  VALIDATION_STATUSES,
} from '../observation.js';
import { setLastSelection } from './status.js';

const router = express.Router();

router.post('/v1/chat/completions', async (req, res) => {
  let mode = null;
  let selection = null;
  let upstreamRequest = null;
  // Correlates selection_event -> request_event for dynamic modes. Plain
  // (non-dynamic) passthrough requests keep request_id null.
  let requestId = null;

  try {
    const { model, messages, ...rest } = req.body;

    if (model?.startsWith('dynamic-')) {
      mode = model;
    } else if (model === 'openrouter/auto') {
      mode = 'dynamic-auto';
    }

    if (mode) {
      const catalog = getCatalog();
      if (!catalog || catalog.length === 0) {
        recordRequest({
          mode,
          selectedModel: null,
          status: 'error',
          error: 'Catalog not loaded. Use POST /admin/refresh first.',
          isError: true,
          isEmpty: null,
          hasContent: null,
          validationStatus: VALIDATION_STATUSES.ERROR,
          validationSource: 'automatic',
          functionalSuccess: null,
        });
        return res.status(503).json({
          error: {
            code: 'catalog_not_loaded',
            message: 'Model catalog not loaded. Use POST /admin/refresh first.',
          },
        });
      }

      const hasTools = rest.tools && rest.tools.length > 0;
      const requestInfo = {
        requireTools: hasTools,
        requireToolChoice: Boolean(rest.tool_choice),
      };

      try {
        selection = selectModel(catalog, mode, requestInfo);
        // dynamic-balanced now returns its correlation id; other modes fall
        // back to a locally generated id so every dynamic execution can be
        // joined back to its selection.
        requestId = selection?.requestId || newRequestId();
        setLastSelection(mode, selection);
      } catch (error) {
        recordRequest({
          mode,
          selectedModel: null,
          status: 'error',
          error: error.message,
          isError: true,
          isEmpty: null,
          hasContent: null,
          validationStatus: VALIDATION_STATUSES.ERROR,
          validationSource: 'automatic',
          functionalSuccess: null,
        });
        return res.status(400).json({
          error: {
            code: 'selection_failed',
            message: error.message,
          },
        });
      }
    }

    if (mode === 'dynamic-auto') {
      const plugins = [
        {
          id: 'auto-router',
          enabled: true,
        },
      ];

      const costTier = config.auto.costTier;
      if (costTier) {
        plugins[0].cost_tier = costTier;
      }

      upstreamRequest = {
        model: 'openrouter/auto',
        messages,
        ...rest,
        plugins,
      };
    } else if (selection) {
      upstreamRequest = {
        model: selection.model,
        messages,
        ...rest,
      };
    } else {
      upstreamRequest = req.body;
    }

    const headers = {
      'Authorization': `Bearer ${env.openRouterApiKey}`,
      'Content-Type': 'application/json',
    };

    if (env.openRouterApiKey) {
      headers['HTTP-Referer'] = 'http://localhost:4000';
      headers['X-OpenRouter-Title'] = 'Dynamic Router Proxy';
    }

    const shouldStream = upstreamRequest.stream === true;

    const upstreamResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamRequest),
    });

    if (!upstreamResponse.ok) {
      const errorBody = await upstreamResponse.text();
      const statusCode = upstreamResponse.status;
      const failed = extractErrorObservation({
        upstreamRequest,
        status: `${statusCode}`,
        error: `OpenRouter error: ${upstreamResponse.statusText}`,
      });
      recordRequest({
        ...failed,
        mode,
        requestId,
        selectedModel: selection?.model ?? null,
        validationStatus: VALIDATION_STATUSES.ERROR,
        validationSource: 'automatic',
        functionalSuccess: null,
      });
      return res.status(statusCode).json({
        error: {
          code: `upstream_${statusCode}`,
          message: errorBody,
        },
      });
    }

    if (shouldStream && upstreamResponse.body) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');

      // Relay is byte-identical: chunks are forwarded untouched while a
      // lightweight summary is folded for the observation row. Fields the
      // upstream never sends stay null; relay never blocks on parsing.
      const events = [];
      let buffer = '';
      try {
        for await (const chunk of relayStreamChunks(upstreamResponse.body)) {
          res.write(chunk);
          buffer += chunk.toString('utf8');
          const { events: done, remainder } = splitSsePayloads(buffer);
          events.push(...done);
          buffer = remainder;
        }
        res.end();
      } catch {
        res.end();
      }
      const summary = summarizeStreamEvents(events, upstreamRequest);
      recordRequest({
        mode,
        requestId,
        selectedModel: summary.model || selection?.model || null,
        provider: summary.provider,
        maxTokens: summary.maxTokens,
        promptTokens: summary.promptTokens,
        completionTokens: summary.completionTokens,
        reasoningTokens: summary.reasoningTokens,
        totalTokens: summary.totalTokens,
        status: 'success',
        error: null,
        cost: summary.cost,
        finishReason: summary.finishReason,
        nativeFinishReason: summary.nativeFinishReason,
        contentLength: summary.contentLength,
        hasContent: summary.hasContent,
        isError: false,
        isEmpty: summary.isEmpty,
        validationStatus: classifyObservation({
          isError: false,
          finishReason: summary.finishReason,
          hasContent: summary.hasContent,
          contentLength: summary.contentLength,
          isEmpty: summary.isEmpty,
        }),
        validationSource: 'automatic',
        functionalSuccess: null,
      });
      return;
    }

    const data = await upstreamResponse.json();

    const observed = extractObservation({ upstreamRequest, data });
    const validationStatus = classifyObservation({
      isError: observed.isError,
      finishReason: observed.finishReason,
      hasContent: observed.hasContent,
      contentLength: observed.contentLength,
      isEmpty: observed.isEmpty,
    });
    recordRequest({
      mode,
      requestId,
      selectedModel: observed.model || selection?.model || null,
      provider: observed.provider,
      maxTokens: observed.maxTokens,
      promptTokens: observed.promptTokens,
      completionTokens: observed.completionTokens,
      reasoningTokens: observed.reasoningTokens,
      totalTokens: observed.totalTokens,
      status: 'success',
      error: null,
      cost: observed.cost,
      finishReason: observed.finishReason,
      nativeFinishReason: observed.nativeFinishReason,
      contentLength: observed.contentLength,
      hasContent: observed.hasContent,
      isError: observed.isError,
      isEmpty: observed.isEmpty,
      // API-level completion only; functional success needs explicit later
      // validation via recordValidation.
      validationStatus,
      validationSource: 'automatic',
      functionalSuccess: null,
    });

    res.json(data);

  } catch (error) {
    const failed = extractErrorObservation({
      upstreamRequest: upstreamRequest || {},
      status: 'error',
      error: error.message,
    });
    recordRequest({
      ...failed,
      mode,
      requestId,
      selectedModel: selection?.model ?? null,
      validationStatus: VALIDATION_STATUSES.ERROR,
      validationSource: 'automatic',
      functionalSuccess: null,
    });
    res.status(500).json({
      error: {
        code: 'internal_error',
        message: error.message,
      },
    });
  }
});

export default router;
