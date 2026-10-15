const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { DATASET, SAMPLE_ASSETS, runBacktest, validateStrategy } = require('./backtest');
const { buildLatestSignal, runRealBacktest, validateRealRules } = require('./real-backtest');
const { DEFAULT_CODES, loadRealDataset, syncMarketData } = require('./market-data');
const { searchInstruments } = require('./instrument-search');
const { analyzeStock, buildRadar, enrichRadarSnapshotHistory, fetchRadarSnapshot, loadRadarSnapshot } = require('./market-radar');
const { analyzeRadarWithAgent, analyzeStockWithAgent, applyRadarAgentResult, getAiAgentStatus } = require('./ai-agent');
const {
  readState,
  publicState,
  saveStrategyVersion,
  createCompletedJob,
  saveRadar,
  saveRadarSettings,
  saveHolding,
  removeHolding
} = require('./store');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': CONTENT_TYPES['.json'], 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

async function applyRadarAi(radar) {
  const aiStatus = getAiAgentStatus();
  if (radar.settings?.aiEnabled === false) {
    return {
      ...radar,
      ai: {
        status: 'disabled',
        model: aiStatus.model,
        message: 'AI 研判已关闭，当前按固定规则排序'
      }
    };
  }
  if (!radar.candidatePool.length) {
    return {
      ...radar,
      ai: {
        status: 'skipped',
        model: aiStatus.model,
        message: '规则候选池为空，本次没有可供 AI 比较的证券'
      }
    };
  }
  if (!aiStatus.enabled) {
    return {
      ...radar,
      ai: {
        status: 'not-configured',
        model: aiStatus.model,
        message: 'AI 未配置，本次沿用规则排序结果'
      }
    };
  }
  try {
    const agentOutput = await analyzeRadarWithAgent(radar);
    return applyRadarAgentResult(radar, agentOutput);
  } catch (error) {
    return {
      ...radar,
      ai: {
        status: 'error',
        model: aiStatus.model,
        message: error.status === 429
          ? 'AI 服务当前繁忙，本次沿用规则排序结果'
          : 'AI 本次没有完成候选比较，已沿用规则排序结果'
      }
    };
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      const error = new Error('请求内容过大');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    const invalid = new Error('请求格式不正确');
    invalid.statusCode = 400;
    throw invalid;
  }
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/instruments/search') {
    const query = String(url.searchParams.get('q') || '').trim();
    if (query.length > 32) return sendJson(response, 400, { error: '搜索内容不能超过 32 个字符' });
    const realDataset = await loadRealDataset();
    const instruments = await searchInstruments(query, realDataset?.assets || []);
    return sendJson(response, 200, { instruments });
  }

  if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
    const state = await readState();
    const realDataset = await loadRealDataset();
    const dataset = realDataset ? realDataset.metadata : DATASET;
    const instruments = realDataset
      ? realDataset.assets.map(({ id, name, industry, market }) => ({ id, name, industry, market }))
      : SAMPLE_ASSETS.map(({ id, name, industry }) => ({ id, name, industry, market: 'SIM' }));
    return sendJson(response, 200, {
      ...publicState(state, dataset.id, realDataset ? realDataset.assets : SAMPLE_ASSETS),
      dataset,
      instruments,
      defaultSyncCodes: DEFAULT_CODES,
      aiAgent: getAiAgentStatus()
    });
  }

  if (request.method === 'POST' && url.pathname === '/api/radar/refresh') {
    const state = await readState();
    const { snapshot, news } = await fetchRadarSnapshot(state.radarSettings);
    const radar = await applyRadarAi(buildRadar(snapshot, news, state.holdings || [], state.radarSettings));
    const priceByCode = Object.fromEntries(snapshot.quotes.map((item) => [item.code, item.price]));
    const saved = await saveRadar(radar, priceByCode);
    return sendJson(response, 200, saved);
  }

  if (request.method === 'POST' && url.pathname === '/api/radar/settings') {
    const payload = await readJson(request);
    const settings = await saveRadarSettings(payload);
    return sendJson(response, 200, { settings });
  }

  if (request.method === 'POST' && url.pathname === '/api/radar/ai-toggle') {
    const payload = await readJson(request);
    if (typeof payload.enabled !== 'boolean') {
      return sendJson(response, 400, { error: '请提供有效的 AI 研判开关状态' });
    }
    const state = await readState();
    const nextSettings = { ...state.radarSettings, aiEnabled: payload.enabled };
    const { snapshot, news } = await loadRadarSnapshot();
    const radar = await applyRadarAi(buildRadar(snapshot, news, state.holdings || [], nextSettings));
    const settings = await saveRadarSettings(nextSettings);
    const priceByCode = Object.fromEntries(snapshot.quotes.map((item) => [item.code, item.price]));
    const saved = await saveRadar(radar, priceByCode);
    return sendJson(response, 200, { ...saved, settings });
  }

  if (request.method === 'POST' && url.pathname === '/api/radar/analyze') {
    const payload = await readJson(request);
    const code = String(payload.code || '').trim();
    if (!/^\d{6}$/.test(code)) return sendJson(response, 400, { error: '请选择有效的六位证券代码' });
    const state = await readState();
    let { snapshot, news } = await loadRadarSnapshot();
    const targetQuote = snapshot.quotes.find((item) => item.code === code);
    if (targetQuote && (!targetQuote.recentMetrics || targetQuote.recentMetrics.asOfDate !== snapshot.asOfDate)) {
      snapshot = await enrichRadarSnapshotHistory(snapshot, [code]);
    }
    const analysis = analyzeStock(snapshot, news, code, state.radarSettings);
    const aiStatus = getAiAgentStatus();
    const aiEnabled = state.radarSettings?.aiEnabled !== false;
    let ai = aiEnabled
      ? { status: 'skipped', model: aiStatus.model, message: '本次只更新固定规则分析' }
      : { status: 'disabled', model: aiStatus.model, message: 'AI 研判已关闭，当前只显示固定规则分析' };
    if (aiEnabled && payload.includeAi !== false) {
      if (!aiStatus.enabled) {
        ai = { status: 'not-configured', model: aiStatus.model, message: aiStatus.message };
      } else {
        try {
          ai = await analyzeStockWithAgent(analysis);
        } catch (error) {
          const message = error.code === 'AI_NOT_CONFIGURED'
            ? 'AI 研判尚未配置'
            : error.status === 429
              ? 'AI 服务当前繁忙，可稍后重新研判'
              : 'AI 研判暂时没有完成，可继续使用固定规则分析';
          ai = {
            status: 'error',
            model: aiStatus.model,
            message
          };
        }
      }
    }
    return sendJson(response, 200, { analysis, ai });
  }

  if (request.method === 'POST' && url.pathname === '/api/holdings') {
    const payload = await readJson(request);
    const holding = await saveHolding(payload);
    return sendJson(response, 201, { holding });
  }

  const holdingMatch = url.pathname.match(/^\/api\/holdings\/([^/]+)$/);
  if (request.method === 'DELETE' && holdingMatch) {
    const removed = await removeHolding(holdingMatch[1]);
    if (!removed) return sendJson(response, 404, { error: '没有找到该持仓' });
    return sendJson(response, 200, { removed: true });
  }

  const versionMatch = url.pathname.match(/^\/api\/strategies\/([^/]+)\/versions$/);
  if (request.method === 'POST' && versionMatch) {
    const payload = await readJson(request);
    const realDataset = await loadRealDataset();
    const errors = payload.rules?.strategyKind === 'price-factor-v1'
      ? validateRealRules(payload.rules, realDataset ? realDataset.assets.length : 40)
      : validateStrategy(payload.rules);
    if (errors.length) return sendJson(response, 400, { error: errors.join('；'), details: errors });
    const strategy = await saveStrategyVersion(versionMatch[1], payload);
    if (!strategy) return sendJson(response, 404, { error: '没有找到该策略' });
    return sendJson(response, 201, { strategy });
  }

  if (request.method === 'POST' && url.pathname === '/api/backtests') {
    const payload = await readJson(request);
    const realDataset = await loadRealDataset();
    const isRealStrategy = payload.rules?.strategyKind === 'price-factor-v1';
    const errors = isRealStrategy
      ? validateRealRules(payload.rules, realDataset ? realDataset.assets.length : 40)
      : validateStrategy(payload.rules);
    if (errors.length) return sendJson(response, 400, { error: errors.join('；'), details: errors });
    if (isRealStrategy && !realDataset) return sendJson(response, 412, { error: '请先在数据页面更新真实行情' });
    const result = isRealStrategy ? runRealBacktest(payload.rules, realDataset) : runBacktest(payload.rules);
    const job = await createCompletedJob(payload.strategyId, payload.versionId, result);
    return sendJson(response, 201, { job, result });
  }

  if (request.method === 'POST' && url.pathname === '/api/signals/latest') {
    const payload = await readJson(request);
    const realDataset = await loadRealDataset();
    if (!realDataset) return sendJson(response, 412, { error: '请先在数据页面更新真实行情' });
    const errors = validateRealRules(payload.rules, realDataset.assets.length);
    if (errors.length) return sendJson(response, 400, { error: errors.join('；'), details: errors });
    return sendJson(response, 200, { signal: buildLatestSignal(payload.rules, realDataset) });
  }

  if (request.method === 'POST' && url.pathname === '/api/data/sync') {
    const payload = await readJson(request);
    const dataset = await syncMarketData(Array.isArray(payload.codes) ? payload.codes : DEFAULT_CODES);
    return sendJson(response, 200, {
      dataset: dataset.metadata,
      instruments: dataset.assets.map(({ id, name, industry, market }) => ({ id, name, industry, market }))
    });
  }

  return sendJson(response, 404, { error: '没有找到该接口' });
}

async function serveStatic(response, pathname) {
  const requestPath = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const filePath = path.resolve(PUBLIC_DIR, `.${requestPath}`);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  try {
    const content = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, { 'Content-Type': CONTENT_TYPES[extension] || 'application/octet-stream' });
    response.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const fallback = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'));
      response.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html'] });
      response.end(fallback);
      return;
    }
    throw error;
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : '本地服务暂时无法完成请求' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`策研台已启动：http://${HOST}:${PORT}`);
});
