const { randomUUID } = require('crypto');
const { buildResultAnalysis } = require('./result-analysis');

const SAMPLE_ASSETS = [
  { id: 'SIM001', name: '样本一', industry: '制造', roe: 0.142, pe: 16.8, drift: 0.105, volatility: 0.22, seed: 101 },
  { id: 'SIM002', name: '样本二', industry: '消费', roe: 0.188, pe: 24.5, drift: 0.125, volatility: 0.19, seed: 202 },
  { id: 'SIM003', name: '样本三', industry: '医药', roe: 0.116, pe: 31.2, drift: 0.082, volatility: 0.25, seed: 303 },
  { id: 'SIM004', name: '样本四', industry: '科技', roe: 0.213, pe: 42.0, drift: 0.155, volatility: 0.31, seed: 404 },
  { id: 'SIM005', name: '样本五', industry: '材料', roe: 0.096, pe: 13.1, drift: 0.072, volatility: 0.24, seed: 505 },
  { id: 'SIM006', name: '样本六', industry: '公用', roe: 0.108, pe: 18.4, drift: 0.065, volatility: 0.14, seed: 606 },
  { id: 'SIM007', name: '样本七', industry: '制造', roe: 0.174, pe: 21.3, drift: 0.118, volatility: 0.21, seed: 707 },
  { id: 'SIM008', name: '样本八', industry: '消费', roe: 0.132, pe: 27.8, drift: 0.092, volatility: 0.18, seed: 808 },
  { id: 'SIM009', name: '样本九', industry: '医药', roe: 0.201, pe: 36.5, drift: 0.138, volatility: 0.27, seed: 909 },
  { id: 'SIM010', name: '样本十', industry: '科技', roe: 0.155, pe: 29.6, drift: 0.145, volatility: 0.29, seed: 1010 },
  { id: 'SIM011', name: '样本十一', industry: '材料', roe: 0.084, pe: 11.7, drift: 0.052, volatility: 0.23, seed: 1111 },
  { id: 'SIM012', name: '样本十二', industry: '公用', roe: 0.127, pe: 19.9, drift: 0.078, volatility: 0.15, seed: 1212 }
];

const DATASET = {
  id: 'sample-daily-v1',
  name: '本地模拟日频数据',
  kind: 'synthetic',
  startDate: '2023-01-02',
  endDate: '2025-12-31',
  researchStartDate: '2024-01-02',
  instrumentCount: SAMPLE_ASSETS.length,
  status: 'ready',
  note: '仅用于验证产品流程与计算一致性，不代表真实证券。'
};

function defaultStrategy() {
  return {
    name: '质量价值趋势组合',
    rules: {
      minRoe: 8,
      maxPe: 38,
      topCount: 6,
      maxPosition: 20,
      cashReserve: 2,
      frequency: 'monthly',
      commissionBps: 3,
      slippageBps: 5,
      weights: {
        valuation: 35,
        quality: 30,
        trend: 25,
        stability: 10
      }
    }
  };
}

function validateStrategy(rules) {
  const errors = [];
  if (!rules || typeof rules !== 'object') {
    return ['缺少策略规则'];
  }
  const weightTotal = Object.values(rules.weights || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  if (Math.abs(weightTotal - 100) > 0.001) {
    errors.push('四项排序权重合计必须为 100%');
  }
  if (!Number.isInteger(Number(rules.topCount)) || Number(rules.topCount) < 1 || Number(rules.topCount) > SAMPLE_ASSETS.length) {
    errors.push(`持仓数量必须在 1 至 ${SAMPLE_ASSETS.length} 之间`);
  }
  if (Number(rules.maxPosition) <= 0 || Number(rules.maxPosition) > 100) {
    errors.push('单只权重上限必须大于 0 且不超过 100%');
  }
  if (Number(rules.cashReserve) < 0 || Number(rules.cashReserve) > 30) {
    errors.push('现金保留比例必须在 0% 至 30% 之间');
  }
  if (!['daily', 'weekly', 'monthly'].includes(rules.frequency)) {
    errors.push('调仓周期不受支持');
  }
  return errors;
}

function createRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (1664525 * value + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function tradingDates(start, end) {
  const dates = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function generateDataset() {
  const dates = tradingDates(DATASET.startDate, DATASET.endDate);
  const series = {};
  SAMPLE_ASSETS.forEach((asset, assetIndex) => {
    const random = createRandom(asset.seed);
    let close = 24 + assetIndex * 3.2;
    series[asset.id] = dates.map((date, index) => {
      const normalNoise = (random() + random() + random() + random() + random() + random()) - 3;
      const dailyMove = asset.drift / 252 + (asset.volatility / Math.sqrt(252)) * normalNoise;
      const overnightMove = dailyMove * 0.32 + (random() - 0.5) * 0.004;
      const open = Math.max(2, close * (1 + overnightMove));
      close = Math.max(2, open * (1 + dailyMove * 0.68));
      const cycle = Math.sin((index + assetIndex * 13) / 90);
      return {
        date,
        open: round(open, 4),
        close: round(close, 4),
        roe: asset.roe + cycle * 0.012,
        pe: Math.max(5, asset.pe * (1 + cycle * 0.09))
      };
    });
  });
  return { dates, series };
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sampleStd(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function percentileRanks(items, valueKey) {
  const sorted = [...items].sort((a, b) => a[valueKey] - b[valueKey] || a.id.localeCompare(b.id));
  const ranks = new Map();
  sorted.forEach((item, index) => {
    ranks.set(item.id, sorted.length === 1 ? 1 : index / (sorted.length - 1));
  });
  return ranks;
}

function selectTargets(dataset, dayIndex, rules) {
  const candidates = SAMPLE_ASSETS.map((asset) => {
    const rows = dataset.series[asset.id];
    const row = rows[dayIndex];
    const previous60 = rows[Math.max(0, dayIndex - 60)].close;
    const returns20 = [];
    for (let index = Math.max(1, dayIndex - 19); index <= dayIndex; index += 1) {
      returns20.push(rows[index].close / rows[index - 1].close - 1);
    }
    return {
      ...asset,
      roe: row.roe,
      pe: row.pe,
      valuationMetric: -row.pe,
      qualityMetric: row.roe,
      trendMetric: row.close / previous60 - 1,
      stabilityMetric: -sampleStd(returns20)
    };
  }).filter((item) => item.roe * 100 >= Number(rules.minRoe) && item.pe <= Number(rules.maxPe));

  if (!candidates.length) return [];

  const valuationRanks = percentileRanks(candidates, 'valuationMetric');
  const qualityRanks = percentileRanks(candidates, 'qualityMetric');
  const trendRanks = percentileRanks(candidates, 'trendMetric');
  const stabilityRanks = percentileRanks(candidates, 'stabilityMetric');

  const ranked = candidates.map((item) => {
    const score = (
      valuationRanks.get(item.id) * Number(rules.weights.valuation) +
      qualityRanks.get(item.id) * Number(rules.weights.quality) +
      trendRanks.get(item.id) * Number(rules.weights.trend) +
      stabilityRanks.get(item.id) * Number(rules.weights.stability)
    ) / 100;
    return { ...item, score };
  });

  return ranked
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Number(rules.topCount));
}

function isSignalDay(dates, index, frequency) {
  if (frequency === 'daily') return true;
  const current = new Date(`${dates[index]}T00:00:00Z`);
  const next = dates[index + 1] ? new Date(`${dates[index + 1]}T00:00:00Z`) : null;
  if (!next) return false;
  if (frequency === 'weekly') {
    return current.getUTCDay() > next.getUTCDay();
  }
  return current.getUTCMonth() !== next.getUTCMonth();
}

function buildMonthlyReturns(points) {
  const monthEnds = [];
  points.forEach((point, index) => {
    const next = points[index + 1];
    if (!next || next.date.slice(0, 7) !== point.date.slice(0, 7)) {
      monthEnds.push(point);
    }
  });
  let previousNav = 1;
  return monthEnds.map((point) => {
    const value = point.nav / previousNav - 1;
    previousNav = point.nav;
    return { month: point.date.slice(0, 7), value: round(value, 6) };
  });
}

function calculateMetrics(points, totalTradeValue) {
  const returns = [];
  let peak = 1;
  let maxDrawdown = 0;
  points.forEach((point, index) => {
    if (index > 0) returns.push(point.nav / points[index - 1].nav - 1);
    peak = Math.max(peak, point.nav);
    maxDrawdown = Math.min(maxDrawdown, point.nav / peak - 1);
  });
  const finalNav = points[points.length - 1].nav;
  const annualizedReturn = finalNav ** (252 / Math.max(1, returns.length)) - 1;
  const volatility = sampleStd(returns) * Math.sqrt(252);
  const dailyRiskFree = 1.02 ** (1 / 252) - 1;
  const sharpe = volatility === 0 ? null : ((mean(returns) - dailyRiskFree) / sampleStd(returns)) * Math.sqrt(252);
  const averageAsset = mean(points.map((point) => point.asset));
  const annualizedTurnover = averageAsset === 0 ? 0 : (totalTradeValue / 2 / averageAsset) * (252 / points.length);
  const benchmarkReturn = points[points.length - 1].benchmark - 1;

  return {
    cumulativeReturn: round(finalNav - 1, 6),
    annualizedReturn: round(annualizedReturn, 6),
    maxDrawdown: round(maxDrawdown, 6),
    volatility: round(volatility, 6),
    sharpe: sharpe === null ? null : round(sharpe, 4),
    excessReturn: round(finalNav - 1 - benchmarkReturn, 6),
    annualizedTurnover: round(annualizedTurnover, 6)
  };
}

function runBacktest(rules) {
  const errors = validateStrategy(rules);
  if (errors.length) {
    const error = new Error(errors.join('；'));
    error.statusCode = 400;
    throw error;
  }

  const startedAt = Date.now();
  const dataset = generateDataset();
  const startIndex = dataset.dates.findIndex((date) => date >= DATASET.researchStartDate);
  const positions = new Map();
  const trades = [];
  const points = [];
  let cash = 1000000;
  let totalTradeValue = 0;
  let pendingTargets = selectTargets(dataset, startIndex - 1, rules);
  const benchmarkBases = new Map(SAMPLE_ASSETS.map((asset) => [asset.id, dataset.series[asset.id][startIndex - 1].close]));

  for (let dayIndex = startIndex; dayIndex < dataset.dates.length; dayIndex += 1) {
    const date = dataset.dates[dayIndex];

    if (pendingTargets) {
      // 调仓先卖后买，目标数量基于当日开盘资产计算，并按 100 股向下取整。
      const openAsset = cash + SAMPLE_ASSETS.reduce((sum, asset) => {
        const position = positions.get(asset.id);
        return sum + (position ? position.quantity * dataset.series[asset.id][dayIndex].open : 0);
      }, 0);
      const targetIds = new Set(pendingTargets.map((item) => item.id));
      const reserveRatio = Number(rules.cashReserve) / 100;
      const targetWeight = Math.min(
        (1 - reserveRatio) / Math.max(1, pendingTargets.length),
        Number(rules.maxPosition) / 100
      );
      const desiredQuantities = new Map();
      SAMPLE_ASSETS.forEach((asset) => {
        const openPrice = dataset.series[asset.id][dayIndex].open;
        const desiredValue = targetIds.has(asset.id) ? openAsset * targetWeight : 0;
        desiredQuantities.set(asset.id, Math.floor(desiredValue / openPrice / 100) * 100);
      });

      SAMPLE_ASSETS.forEach((asset) => {
        const current = positions.get(asset.id);
        const currentQuantity = current ? current.quantity : 0;
        const desiredQuantity = desiredQuantities.get(asset.id);
        if (currentQuantity <= desiredQuantity) return;
        const quantity = currentQuantity - desiredQuantity;
        const price = dataset.series[asset.id][dayIndex].open * (1 - Number(rules.slippageBps) / 10000);
        const amount = quantity * price;
        const commission = Math.max(5, amount * Number(rules.commissionBps) / 10000);
        const tax = amount * 0.0005;
        cash += amount - commission - tax;
        totalTradeValue += amount;
        const referencePrice = dataset.series[asset.id][dayIndex].open;
        trades.push({
          id: randomUUID(), date, assetId: asset.id, name: asset.name, side: 'sell', quantity,
          price: round(price, 3), referencePrice: round(referencePrice, 3),
          amount: round(amount), referenceAmount: round(quantity * referencePrice),
          commission: round(commission), tax: round(tax), slippageCost: round(quantity * (referencePrice - price)),
          fee: round(commission + tax), reason: '规则调仓'
        });
        if (desiredQuantity === 0) positions.delete(asset.id);
        else positions.set(asset.id, { quantity: desiredQuantity, averageCost: current.averageCost });
      });

      pendingTargets.forEach((asset) => {
        const current = positions.get(asset.id);
        const currentQuantity = current ? current.quantity : 0;
        const desiredQuantity = desiredQuantities.get(asset.id);
        if (desiredQuantity <= currentQuantity) return;
        const price = dataset.series[asset.id][dayIndex].open * (1 + Number(rules.slippageBps) / 10000);
        let quantity = desiredQuantity - currentQuantity;
        let amount = quantity * price;
        let commission = Math.max(5, amount * Number(rules.commissionBps) / 10000);
        if (amount + commission > cash) {
          quantity = Math.max(0, Math.floor((cash - 5) / price / 100) * 100);
          amount = quantity * price;
          commission = quantity ? Math.max(5, amount * Number(rules.commissionBps) / 10000) : 0;
        }
        if (!quantity) return;
        cash -= amount + commission;
        totalTradeValue += amount;
        const previousCost = current ? current.averageCost * current.quantity : 0;
        const newQuantity = currentQuantity + quantity;
        positions.set(asset.id, { quantity: newQuantity, averageCost: (previousCost + amount + commission) / newQuantity });
        const referencePrice = dataset.series[asset.id][dayIndex].open;
        trades.push({
          id: randomUUID(), date, assetId: asset.id, name: asset.name, side: 'buy', quantity,
          price: round(price, 3), referencePrice: round(referencePrice, 3),
          amount: round(amount), referenceAmount: round(quantity * referencePrice),
          commission: round(commission), tax: 0, slippageCost: round(quantity * (price - referencePrice)),
          fee: round(commission), reason: '规则调仓'
        });
      });
      pendingTargets = null;
    }

    const marketValue = SAMPLE_ASSETS.reduce((sum, asset) => {
      const position = positions.get(asset.id);
      return sum + (position ? position.quantity * dataset.series[asset.id][dayIndex].close : 0);
    }, 0);
    const assetValue = cash + marketValue;
    const benchmark = mean(SAMPLE_ASSETS.map((asset) => dataset.series[asset.id][dayIndex].close / benchmarkBases.get(asset.id)));
    const previousPeak = points.length ? Math.max(...points.map((point) => point.nav)) : 1;
    const nav = assetValue / 1000000;
    points.push({ date, nav: round(nav, 8), benchmark: round(benchmark, 8), drawdown: round(nav / Math.max(previousPeak, nav) - 1, 8), asset: round(assetValue), cash: round(cash) });

    if (dayIndex < dataset.dates.length - 1 && isSignalDay(dataset.dates, dayIndex, rules.frequency)) {
      pendingTargets = selectTargets(dataset, dayIndex, rules);
    }
  }

  const lastIndex = dataset.dates.length - 1;
  const holdings = SAMPLE_ASSETS.map((asset) => {
    const position = positions.get(asset.id);
    if (!position) return null;
    const close = dataset.series[asset.id][lastIndex].close;
    const marketValue = position.quantity * close;
    const totalAsset = points[points.length - 1].asset;
    return {
      assetId: asset.id,
      name: asset.name,
      industry: asset.industry,
      quantity: position.quantity,
      close: round(close, 3),
      marketValue: round(marketValue),
      weight: round(marketValue / totalAsset, 6),
      returnSinceCost: round(close / position.averageCost - 1, 6)
    };
  }).filter(Boolean).sort((a, b) => b.weight - a.weight);

  const result = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    datasetId: DATASET.id,
    engineVersion: '0.1.0',
    rules,
    metrics: calculateMetrics(points, totalTradeValue),
    points,
    monthlyReturns: buildMonthlyReturns(points),
    holdings,
    trades: trades.slice().reverse(),
    summary: {
      tradingDays: points.length,
      tradeCount: trades.length,
      finalAsset: points[points.length - 1].asset,
      cash: points[points.length - 1].cash
    },
    durationMs: Date.now() - startedAt
  };
  result.analysis = buildResultAnalysis(result, SAMPLE_ASSETS);
  return result;
}

module.exports = {
  DATASET,
  SAMPLE_ASSETS,
  defaultStrategy,
  validateStrategy,
  runBacktest
};
