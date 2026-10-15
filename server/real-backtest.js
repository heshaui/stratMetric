const { randomUUID } = require('crypto');
const { buildResultAnalysis } = require('./result-analysis');

function defaultRealStrategy() {
  return {
    name: '真实行情动态趋势组合',
    rules: {
      strategyKind: 'price-factor-v1',
      minAverageAmount: 100,
      trendWindow: 60,
      volatilityWindow: 20,
      topCount: 5,
      maxPosition: 22,
      cashReserve: 2,
      frequency: 'monthly',
      commissionBps: 3,
      slippageBps: 5,
      weights: {
        trend: 55,
        stability: 25,
        liquidity: 20
      }
    }
  };
}

function validateRealRules(rules) {
  const errors = [];
  if (!rules || typeof rules !== 'object') return ['缺少策略规则'];
  const total = Object.values(rules.weights || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  if (Math.abs(total - 100) > 0.001) errors.push('三项排序权重合计必须为 100%');
  if (!Number.isInteger(Number(rules.topCount)) || Number(rules.topCount) < 1 || Number(rules.topCount) > 40) {
    errors.push('目标持仓数量必须在 1 至 40 之间；可用证券不足时持有全部候选');
  }
  if (Number(rules.trendWindow) < 20 || Number(rules.trendWindow) > 250) errors.push('趋势观察期必须在 20 至 250 个交易日之间');
  if (Number(rules.volatilityWindow) < 10 || Number(rules.volatilityWindow) > 120) errors.push('波动观察期必须在 10 至 120 个交易日之间');
  if (Number(rules.minAverageAmount) < 0) errors.push('平均成交金额下限不能小于零');
  if (Number(rules.maxPosition) <= 0 || Number(rules.maxPosition) > 100) errors.push('单只权重上限必须大于 0 且不超过 100%');
  if (Number(rules.cashReserve) < 0 || Number(rules.cashReserve) > 30) errors.push('现金保留比例必须在 0% 至 30% 之间');
  if (!['daily', 'weekly', 'monthly'].includes(rules.frequency)) errors.push('调仓周期不受支持');
  return errors;
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
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function percentileRanks(items, key) {
  const sorted = [...items].sort((a, b) => a[key] - b[key] || a.id.localeCompare(b.id));
  const ranks = new Map();
  sorted.forEach((item, index) => ranks.set(item.id, sorted.length === 1 ? 1 : index / (sorted.length - 1)));
  return ranks;
}

function rankCandidates(dataset, dayIndex, rules) {
  const candidates = dataset.assets.map((asset) => {
    const rows = dataset.series[asset.id];
    const current = rows[dayIndex];
    if (!current || !current.tradable) return null;
    const trendIndex = dayIndex - Number(rules.trendWindow);
    const volatilityStart = dayIndex - Number(rules.volatilityWindow);
    if (trendIndex < 0 || volatilityStart < 1 || !rows[trendIndex]) return null;

    const recentReturns = [];
    const recentAmounts = [];
    for (let index = volatilityStart; index <= dayIndex; index += 1) {
      if (!rows[index] || !rows[index - 1]) continue;
      recentReturns.push(rows[index].close / rows[index - 1].close - 1);
      if (rows[index].amount > 0) recentAmounts.push(rows[index].amount);
    }
    const averageAmount = mean(recentAmounts);
    if (averageAmount < Number(rules.minAverageAmount) * 1000000) return null;
    const volatilityMetric = sampleStd(recentReturns);
    return {
      ...asset,
      trendMetric: current.close / rows[trendIndex].close - 1,
      stabilityMetric: -volatilityMetric,
      volatilityMetric,
      liquidityMetric: Math.log(Math.max(1, averageAmount)),
      averageAmount,
      close: current.close
    };
  }).filter(Boolean);

  if (!candidates.length) return [];
  const trendRanks = percentileRanks(candidates, 'trendMetric');
  const stabilityRanks = percentileRanks(candidates, 'stabilityMetric');
  const liquidityRanks = percentileRanks(candidates, 'liquidityMetric');
  return candidates.map((item) => ({
    ...item,
    trendRank: trendRanks.get(item.id),
    stabilityRank: stabilityRanks.get(item.id),
    liquidityRank: liquidityRanks.get(item.id),
    score: (
      trendRanks.get(item.id) * Number(rules.weights.trend) +
      stabilityRanks.get(item.id) * Number(rules.weights.stability) +
      liquidityRanks.get(item.id) * Number(rules.weights.liquidity)
    ) / 100
  })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function selectTargets(dataset, dayIndex, rules) {
  return rankCandidates(dataset, dayIndex, rules).slice(0, Number(rules.topCount));
}

function isSignalDay(dates, index, frequency) {
  if (frequency === 'daily') return true;
  if (!dates[index + 1]) return false;
  const current = new Date(`${dates[index]}T00:00:00Z`);
  const next = new Date(`${dates[index + 1]}T00:00:00Z`);
  if (frequency === 'weekly') return current.getUTCDay() > next.getUTCDay();
  return current.getUTCMonth() !== next.getUTCMonth();
}

function weekStartKey(value) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function isLatestSignalDay(dataset, frequency) {
  if (frequency === 'daily') return true;
  const latest = dataset.dates.at(-1);
  const latestDate = new Date(`${latest}T00:00:00Z`);
  const fetchedDate = dataset.metadata.fetchedAt
    ? new Date(dataset.metadata.fetchedAt).toISOString().slice(0, 10)
    : latest;
  if (frequency === 'weekly') {
    return latestDate.getUTCDay() === 5 || weekStartKey(fetchedDate) > weekStartKey(latest);
  }
  const nextCalendarDay = new Date(latestDate);
  nextCalendarDay.setUTCDate(nextCalendarDay.getUTCDate() + 1);
  return nextCalendarDay.getUTCMonth() !== latestDate.getUTCMonth() || fetchedDate.slice(0, 7) > latest.slice(0, 7);
}

function findPreviousSignalIndex(dates, startIndex, frequency) {
  for (let index = startIndex; index >= 0; index -= 1) {
    if (isSignalDay(dates, index, frequency)) return index;
  }
  return -1;
}

function signalRow(item, rank, previousRanks) {
  const previousRank = previousRanks.get(item.id) || null;
  return {
    assetId: item.id,
    name: item.name,
    market: item.market,
    industry: item.industry,
    rank,
    rankChange: previousRank === null ? null : previousRank - rank,
    score: round(item.score, 4),
    trend: round(item.trendMetric, 6),
    volatility: round(item.volatilityMetric * Math.sqrt(252), 6),
    averageAmount: round(item.averageAmount / 1000000, 2),
    close: round(item.close, 3)
  };
}

function buildLatestSignal(rules, dataset) {
  const errors = validateRealRules(rules, dataset.assets.length);
  if (errors.length) {
    const error = new Error(errors.join('；'));
    error.statusCode = 400;
    throw error;
  }

  const latestIndex = dataset.dates.length - 1;
  const currentRanking = rankCandidates(dataset, latestIndex, rules);
  const topCount = Number(rules.topCount);
  const adjustmentDue = isLatestSignalDay(dataset, rules.frequency);
  const referenceIndex = findPreviousSignalIndex(dataset.dates, latestIndex - 1, rules.frequency);
  const referenceRanking = referenceIndex >= 0 ? rankCandidates(dataset, referenceIndex, rules) : [];
  const previousRanks = new Map(referenceRanking.map((item, index) => [item.id, index + 1]));
  const referenceSelected = referenceRanking.slice(0, topCount);
  const referenceIds = new Set(referenceSelected.map((item) => item.id));
  const selected = currentRanking.slice(0, topCount);
  const selectedIds = new Set(selected.map((item) => item.id));
  const currentRanks = new Map(currentRanking.map((item, index) => [item.id, { item, rank: index + 1 }]));

  const selectedRows = selected.map((item, index) => ({
    ...signalRow(item, index + 1, previousRanks),
    status: referenceIds.has(item.id) ? 'retain' : 'add'
  }));
  const removedRows = referenceSelected
    .filter((item) => !selectedIds.has(item.id))
    .map((item) => {
      const current = currentRanks.get(item.id);
      if (current) return { ...signalRow(current.item, current.rank, previousRanks), status: 'remove' };
      return {
        assetId: item.id,
        name: item.name,
        market: item.market,
        industry: item.industry,
        rank: null,
        rankChange: null,
        score: null,
        trend: null,
        volatility: null,
        averageAmount: null,
        close: null,
        status: 'remove'
      };
    });
  const watchRows = currentRanking.slice(topCount, topCount + 3).map((item, index) => ({
    ...signalRow(item, topCount + index + 1, previousRanks),
    status: 'watch'
  }));

  const frequencyText = { daily: '每日', weekly: '每周', monthly: '每月' }[rules.frequency];
  return {
    generatedAt: new Date().toISOString(),
    datasetId: dataset.metadata.id,
    asOfDate: dataset.dates[latestIndex],
    referenceDate: referenceIndex >= 0 ? dataset.dates[referenceIndex] : null,
    mode: adjustmentDue ? 'official' : 'preview',
    frequency: rules.frequency,
    frequencyText,
    nextAction: adjustmentDue
      ? '下一交易日开盘按目标组合调整'
      : `等待本${rules.frequency === 'weekly' ? '周' : '月'}最后一个交易日收盘`,
    candidateCount: currentRanking.length,
    selectedRows,
    removedRows,
    watchRows,
    summary: {
      retainCount: selectedRows.filter((item) => item.status === 'retain').length,
      addCount: selectedRows.filter((item) => item.status === 'add').length,
      removeCount: removedRows.length,
      watchCount: watchRows.length
    },
    assumptions: [
      '排名使用最新完整日线计算',
      '观察预览不会生成新的成交安排',
      '正式信号默认在下一交易日开盘执行'
    ]
  };
}

function buildMonthlyReturns(points) {
  const monthEnds = points.filter((point, index) => !points[index + 1] || points[index + 1].date.slice(0, 7) !== point.date.slice(0, 7));
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
  const finalNav = points.at(-1).nav;
  const annualizedReturn = finalNav ** (252 / Math.max(1, returns.length)) - 1;
  const volatility = sampleStd(returns) * Math.sqrt(252);
  const dailyRiskFree = 1.02 ** (1 / 252) - 1;
  const dailyStd = sampleStd(returns);
  const sharpe = dailyStd === 0 ? null : ((mean(returns) - dailyRiskFree) / dailyStd) * Math.sqrt(252);
  const averageAsset = mean(points.map((point) => point.asset));
  const annualizedTurnover = averageAsset ? (totalTradeValue / 2 / averageAsset) * (252 / points.length) : 0;
  return {
    cumulativeReturn: round(finalNav - 1, 6),
    annualizedReturn: round(annualizedReturn, 6),
    maxDrawdown: round(maxDrawdown, 6),
    volatility: round(volatility, 6),
    sharpe: sharpe === null ? null : round(sharpe, 4),
    excessReturn: round(finalNav - points.at(-1).benchmark, 6),
    annualizedTurnover: round(annualizedTurnover, 6)
  };
}

function runRealBacktest(rules, dataset) {
  const errors = validateRealRules(rules, dataset.assets.length);
  if (errors.length) {
    const error = new Error(errors.join('；'));
    error.statusCode = 400;
    throw error;
  }

  const startedAt = Date.now();
  const warmup = Math.max(Number(rules.trendWindow), Number(rules.volatilityWindow), 60) + 1;
  const startIndex = warmup;
  const positions = new Map();
  const trades = [];
  const points = [];
  let cash = 1000000;
  let totalTradeValue = 0;
  let pendingTargets = selectTargets(dataset, startIndex - 1, rules);
  const benchmarkBases = new Map(dataset.assets.map((asset) => [asset.id, dataset.series[asset.id][startIndex - 1].close]));
  let peakNav = 1;

  for (let dayIndex = startIndex; dayIndex < dataset.dates.length; dayIndex += 1) {
    const date = dataset.dates[dayIndex];
    if (pendingTargets) {
      // 使用前复权开盘价近似成交；停牌日不调整该证券，等待下一次调仓重新判断。
      const openAsset = cash + dataset.assets.reduce((sum, asset) => {
        const position = positions.get(asset.id);
        const row = dataset.series[asset.id][dayIndex];
        return sum + (position && row ? position.quantity * row.open : 0);
      }, 0);
      const targetIds = new Set(pendingTargets.map((item) => item.id));
      const targetWeight = Math.min(
        (1 - Number(rules.cashReserve) / 100) / Math.max(1, pendingTargets.length),
        Number(rules.maxPosition) / 100
      );
      const desired = new Map();
      dataset.assets.forEach((asset) => {
        const row = dataset.series[asset.id][dayIndex];
        const value = targetIds.has(asset.id) && row ? openAsset * targetWeight : 0;
        desired.set(asset.id, row ? Math.floor(value / row.open / 100) * 100 : 0);
      });

      dataset.assets.forEach((asset) => {
        const row = dataset.series[asset.id][dayIndex];
        const current = positions.get(asset.id);
        const currentQuantity = current ? current.quantity : 0;
        const desiredQuantity = desired.get(asset.id);
        if (!row || !row.tradable || currentQuantity <= desiredQuantity) return;
        const quantity = currentQuantity - desiredQuantity;
        const price = row.open * (1 - Number(rules.slippageBps) / 10000);
        const amount = quantity * price;
        const commission = Math.max(5, amount * Number(rules.commissionBps) / 10000);
        const tax = amount * 0.0005;
        cash += amount - commission - tax;
        totalTradeValue += amount;
        trades.push({
          id: randomUUID(), date, assetId: asset.id, name: asset.name, side: 'sell', quantity,
          price: round(price, 3), referencePrice: round(row.open, 3),
          amount: round(amount), referenceAmount: round(quantity * row.open),
          commission: round(commission), tax: round(tax), slippageCost: round(quantity * (row.open - price)),
          fee: round(commission + tax), reason: '动态调仓'
        });
        if (desiredQuantity === 0) positions.delete(asset.id);
        else positions.set(asset.id, { quantity: desiredQuantity, averageCost: current.averageCost });
      });

      pendingTargets.forEach((asset) => {
        const row = dataset.series[asset.id][dayIndex];
        if (!row || !row.tradable) return;
        const current = positions.get(asset.id);
        const currentQuantity = current ? current.quantity : 0;
        const desiredQuantity = desired.get(asset.id);
        if (desiredQuantity <= currentQuantity) return;
        const price = row.open * (1 + Number(rules.slippageBps) / 10000);
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
        trades.push({
          id: randomUUID(), date, assetId: asset.id, name: asset.name, side: 'buy', quantity,
          price: round(price, 3), referencePrice: round(row.open, 3),
          amount: round(amount), referenceAmount: round(quantity * row.open),
          commission: round(commission), tax: 0, slippageCost: round(quantity * (price - row.open)),
          fee: round(commission), reason: '动态调仓'
        });
      });
      pendingTargets = null;
    }

    const marketValue = dataset.assets.reduce((sum, asset) => {
      const position = positions.get(asset.id);
      const row = dataset.series[asset.id][dayIndex];
      return sum + (position && row ? position.quantity * row.close : 0);
    }, 0);
    const assetValue = cash + marketValue;
    const nav = assetValue / 1000000;
    peakNav = Math.max(peakNav, nav);
    const benchmark = mean(dataset.assets.map((asset) => dataset.series[asset.id][dayIndex].close / benchmarkBases.get(asset.id)));
    points.push({ date, nav: round(nav, 8), benchmark: round(benchmark, 8), drawdown: round(nav / peakNav - 1, 8), asset: round(assetValue), cash: round(cash) });
    if (dayIndex < dataset.dates.length - 1 && isSignalDay(dataset.dates, dayIndex, rules.frequency)) {
      pendingTargets = selectTargets(dataset, dayIndex, rules);
    }
  }

  const lastIndex = dataset.dates.length - 1;
  const holdings = dataset.assets.map((asset) => {
    const position = positions.get(asset.id);
    const row = dataset.series[asset.id][lastIndex];
    if (!position || !row) return null;
    const marketValue = position.quantity * row.close;
    return {
      assetId: asset.id,
      name: asset.name,
      industry: asset.industry,
      quantity: position.quantity,
      close: round(row.close, 3),
      marketValue: round(marketValue),
      weight: round(marketValue / points.at(-1).asset, 6),
      returnSinceCost: round(row.close / position.averageCost - 1, 6)
    };
  }).filter(Boolean).sort((a, b) => b.weight - a.weight);

  const result = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    datasetId: dataset.metadata.id,
    engineVersion: '0.2.0-real-price',
    rules,
    metrics: calculateMetrics(points, totalTradeValue),
    points,
    monthlyReturns: buildMonthlyReturns(points),
    holdings,
    trades: trades.reverse(),
    summary: {
      tradingDays: points.length,
      tradeCount: trades.length,
      finalAsset: points.at(-1).asset,
      cash: points.at(-1).cash
    },
    assumptions: [
      '使用前复权日线近似成交与估值',
      '技术验证池为固定代码范围',
      '成交金额由价格与成交量估算',
      '暂未单独计入现金分红'
    ],
    durationMs: Date.now() - startedAt
  };
  result.analysis = buildResultAnalysis(result, dataset.assets);
  return result;
}

module.exports = {
  defaultRealStrategy,
  validateRealRules,
  runRealBacktest,
  buildLatestSignal
};
