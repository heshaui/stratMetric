const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { defaultStrategy } = require('./backtest');
const { defaultRealStrategy } = require('./real-backtest');
const { enrichTradesWithCosts, ensureResultAnalysis } = require('./result-analysis');
const { DEFAULT_RADAR_SETTINGS, normalizeRadarSettings, validateRadarSettings } = require('./market-radar');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

function createInitialState() {
  const now = new Date().toISOString();
  const strategy = defaultStrategy();
  return {
    strategies: [
      {
        id: 'strategy-quality-value',
        name: strategy.name,
        description: '质量、估值与趋势的综合排序样例',
        currentVersionId: 'version-1',
        updatedAt: now,
        versions: [
          {
            id: 'version-1',
            label: 'v1',
            note: '初始规则',
            createdAt: now,
            rules: strategy.rules
          }
        ]
      }
    ],
    jobs: [],
    results: [],
    holdings: [],
    radarSettings: { ...DEFAULT_RADAR_SETTINGS },
    radarHistory: [],
    latestRadar: null
  };
}

function ensurePersonalData(state) {
  let changed = false;
  if (!Array.isArray(state.holdings)) {
    state.holdings = [];
    changed = true;
  }
  if (!Array.isArray(state.radarHistory)) {
    state.radarHistory = [];
    changed = true;
  }
  if (!state.radarSettings || typeof state.radarSettings !== 'object') {
    state.radarSettings = { ...DEFAULT_RADAR_SETTINGS };
    changed = true;
  } else {
    const normalized = normalizeRadarSettings(state.radarSettings);
    if (JSON.stringify(normalized) !== JSON.stringify(state.radarSettings)) {
      state.radarSettings = normalized;
      changed = true;
    }
  }
  if (!Object.hasOwn(state, 'latestRadar')) {
    state.latestRadar = null;
    changed = true;
  }
  return changed;
}

function ensureRealStrategy(state) {
  if (state.strategies.some((strategy) => strategy.id === 'strategy-real-momentum')) return false;
  const now = new Date().toISOString();
  const strategy = defaultRealStrategy();
  state.strategies.unshift({
    id: 'strategy-real-momentum',
    name: strategy.name,
    description: '基于真实前复权日线的趋势、稳定性和流动性动态排序',
    currentVersionId: 'real-version-1',
    updatedAt: now,
    versions: [{
      id: 'real-version-1',
      label: 'v1',
      note: '真实价格策略初始规则',
      createdAt: now,
      rules: strategy.rules
    }]
  });
  return true;
}

async function readState() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const state = JSON.parse(raw);
    const changed = ensureRealStrategy(state) || ensurePersonalData(state);
    if (changed) await writeState(state);
    return state;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    const initialState = createInitialState();
    ensureRealStrategy(initialState);
    await fs.writeFile(STATE_FILE, JSON.stringify(initialState, null, 2), 'utf8');
    return initialState;
  }
}

async function writeState(state) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function publicState(state, datasetId = null, assets = []) {
  const matchingResults = datasetId
    ? state.results.filter((result) => result.datasetId === datasetId)
    : state.results;
  const matchingResultIds = new Set(matchingResults.map((result) => result.id));
  const jobs = datasetId
    ? state.jobs.filter((job) => matchingResultIds.has(job.resultId))
    : state.jobs;
  const latestResult = matchingResults[0];
  return {
    strategies: state.strategies,
    jobs: jobs.slice(0, 20),
    // 旧结果在读取时补齐分析字段，不改写用户已有的本地结果文件。
    latestResult: latestResult
      ? {
          ...latestResult,
          trades: enrichTradesWithCosts(latestResult.trades, latestResult.rules),
          analysis: ensureResultAnalysis(latestResult, assets)
        }
      : null,
    holdings: state.holdings || [],
    radarSettings: normalizeRadarSettings(state.radarSettings),
    latestRadar: state.latestRadar || null,
    radarHistory: (state.radarHistory || []).slice(0, 12)
  };
}

async function saveStrategyVersion(strategyId, payload) {
  const state = await readState();
  const strategy = state.strategies.find((item) => item.id === strategyId);
  if (!strategy) {
    return null;
  }

  const versionNumber = strategy.versions.length + 1;
  const version = {
    id: randomUUID(),
    label: `v${versionNumber}`,
    note: payload.note || '规则调整',
    createdAt: new Date().toISOString(),
    rules: payload.rules
  };
  strategy.name = payload.name || strategy.name;
  strategy.currentVersionId = version.id;
  strategy.updatedAt = version.createdAt;
  strategy.versions.unshift(version);
  await writeState(state);
  return strategy;
}

async function createCompletedJob(strategyId, versionId, result) {
  const state = await readState();
  const now = new Date().toISOString();
  const job = {
    id: randomUUID(),
    strategyId,
    versionId,
    status: 'succeeded',
    progress: 100,
    createdAt: now,
    completedAt: now,
    resultId: result.id,
    durationMs: result.durationMs
  };
  state.jobs.unshift(job);
  state.results.unshift(result);
  state.jobs = state.jobs.slice(0, 50);
  state.results = state.results.slice(0, 20);
  await writeState(state);
  return job;
}

async function saveRadar(radar, priceByCode = {}) {
  const state = await readState();
  const record = {
    asOfDate: radar.asOfDate,
    generatedAt: radar.generatedAt,
    candidates: radar.candidates.map((item) => ({
      code: item.code,
      name: item.name,
      sector: item.sector,
      action: item.action,
      referencePrice: item.price,
      performance: { day1: null, day3: null, day5: null }
    }))
  };
  const existingIndex = state.radarHistory.findIndex((item) => item.asOfDate === radar.asOfDate);
  if (existingIndex >= 0) {
    record.candidates.forEach((candidate) => {
      const previous = state.radarHistory[existingIndex].candidates.find((item) => item.code === candidate.code);
      if (previous?.performance) candidate.performance = previous.performance;
    });
    state.radarHistory.splice(existingIndex, 1, record);
  } else {
    state.radarHistory.push(record);
  }
  state.radarHistory.sort((left, right) => right.asOfDate.localeCompare(left.asOfDate));

  // 只有出现新的市场日期时才推进观察周期，避免同日反复刷新被当成多个交易日。
  const dateOrder = [...new Set(state.radarHistory.map((item) => item.asOfDate))].sort();
  state.radarHistory.forEach((historyItem) => {
    const newerCount = dateOrder.filter((date) => date > historyItem.asOfDate && date <= radar.asOfDate).length;
    const performanceKey = { 1: 'day1', 3: 'day3', 5: 'day5' }[newerCount];
    if (!performanceKey) return;
    historyItem.candidates.forEach((candidate) => {
      const currentPrice = Number(priceByCode[candidate.code]);
      if (!Number.isFinite(currentPrice) || currentPrice <= 0 || candidate.performance[performanceKey] !== null) return;
      candidate.performance[performanceKey] = Math.round((currentPrice / candidate.referencePrice - 1) * 10000) / 10000;
    });
  });

  state.radarHistory = state.radarHistory.slice(0, 40);
  state.latestRadar = radar;
  await writeState(state);
  return {
    radar: state.latestRadar,
    history: state.radarHistory.slice(0, 12)
  };
}

async function saveHolding(payload) {
  const state = await readState();
  const code = String(payload.code || '').trim();
  const quantity = Number(payload.quantity);
  const cost = Number(payload.cost);
  if (!/^\d{6}$/.test(code) || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(cost) || cost <= 0) {
    const error = new Error('请填写六位证券代码、持有数量和有效成本价');
    error.statusCode = 400;
    throw error;
  }
  const holding = {
    id: randomUUID(),
    code,
    name: String(payload.name || code).trim().slice(0, 20),
    quantity: Math.round(quantity),
    cost: Math.round(cost * 1000) / 1000,
    addedAt: new Date().toISOString()
  };
  const existingIndex = state.holdings.findIndex((item) => item.code === code);
  if (existingIndex >= 0) state.holdings.splice(existingIndex, 1, holding);
  else state.holdings.unshift(holding);
  await writeState(state);
  return holding;
}

async function removeHolding(holdingId) {
  const state = await readState();
  const before = state.holdings.length;
  state.holdings = state.holdings.filter((item) => item.id !== holdingId);
  if (state.holdings.length === before) return false;
  await writeState(state);
  return true;
}

async function saveRadarSettings(payload) {
  const errors = validateRadarSettings(payload);
  if (errors.length) {
    const error = new Error(errors.join('；'));
    error.statusCode = 400;
    throw error;
  }
  const state = await readState();
  state.radarSettings = normalizeRadarSettings(payload);
  await writeState(state);
  return state.radarSettings;
}

module.exports = {
  readState,
  publicState,
  saveStrategyVersion,
  createCompletedJob,
  saveRadar,
  saveRadarSettings,
  saveHolding,
  removeHolding
};
