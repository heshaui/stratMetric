const INITIAL_CAPITAL = 1000000;

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sampleStd(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function buildAnnualReturns(points) {
  if (!Array.isArray(points) || !points.length) return [];
  const years = new Map();
  points.forEach((point) => {
    const year = point.date.slice(0, 4);
    if (!years.has(year)) years.set(year, { year, firstDate: point.date, lastDate: point.date, lastPoint: point });
    const entry = years.get(year);
    entry.lastDate = point.date;
    entry.lastPoint = point;
  });

  let previousNav = 1;
  let previousBenchmark = 1;
  return [...years.values()].map((entry) => {
    const strategyReturn = entry.lastPoint.nav / previousNav - 1;
    const benchmarkReturn = entry.lastPoint.benchmark / previousBenchmark - 1;
    previousNav = entry.lastPoint.nav;
    previousBenchmark = entry.lastPoint.benchmark;
    return {
      year: entry.year,
      startDate: entry.firstDate,
      endDate: entry.lastDate,
      complete: entry.firstDate.slice(5, 7) === '01' && entry.lastDate.slice(5, 7) === '12',
      strategyReturn: round(strategyReturn, 8),
      benchmarkReturn: round(benchmarkReturn, 8),
      excessReturn: round(strategyReturn - benchmarkReturn, 8)
    };
  });
}

function inferTradeCosts(trade, rules = {}) {
  const amount = Number(trade.amount || 0);
  const fee = Number(trade.fee || 0);
  const slippageRate = Number(rules.slippageBps || 0) / 10000;
  const inferredTax = trade.side === 'sell' ? Math.min(fee, amount * 0.0005) : 0;
  const tax = Number.isFinite(Number(trade.tax)) ? Number(trade.tax) : inferredTax;
  const commission = Number.isFinite(Number(trade.commission)) ? Number(trade.commission) : Math.max(0, fee - tax);
  let referenceAmount = Number(trade.referenceAmount);
  if (!Number.isFinite(referenceAmount)) {
    const denominator = trade.side === 'buy' ? 1 + slippageRate : 1 - slippageRate;
    referenceAmount = denominator > 0 ? amount / denominator : amount;
  }
  const slippage = Number.isFinite(Number(trade.slippageCost))
    ? Number(trade.slippageCost)
    : Math.abs(amount - referenceAmount);
  return { amount, fee, commission, tax, referenceAmount, slippage };
}

function enrichTradesWithCosts(trades, rules = {}) {
  return (trades || []).map((trade) => {
    const costs = inferTradeCosts(trade, rules);
    const quantity = Number(trade.quantity || 0);
    const referencePrice = Number.isFinite(Number(trade.referencePrice))
      ? Number(trade.referencePrice)
      : (quantity ? costs.referenceAmount / quantity : Number(trade.price || 0));

    // 旧结果只保存了总费用；这里按当时的费率口径补齐明细，不覆盖已经存在的精确值。
    return {
      ...trade,
      referencePrice: Number.isFinite(Number(trade.referencePrice)) ? trade.referencePrice : round(referencePrice, 3),
      referenceAmount: Number.isFinite(Number(trade.referenceAmount)) ? trade.referenceAmount : round(costs.referenceAmount),
      commission: Number.isFinite(Number(trade.commission)) ? trade.commission : round(costs.commission),
      tax: Number.isFinite(Number(trade.tax)) ? trade.tax : round(costs.tax),
      slippageCost: Number.isFinite(Number(trade.slippageCost)) ? trade.slippageCost : round(costs.slippage)
    };
  });
}

function buildCostBreakdown(trades, rules, initialCapital) {
  const totals = (trades || []).reduce((accumulator, trade) => {
    const costs = inferTradeCosts(trade, rules);
    accumulator.commission += costs.commission;
    accumulator.tax += costs.tax;
    accumulator.slippage += costs.slippage;
    accumulator.tradeAmount += costs.amount;
    return accumulator;
  }, { commission: 0, tax: 0, slippage: 0, tradeAmount: 0 });
  const total = totals.commission + totals.tax + totals.slippage;
  return {
    commission: round(totals.commission),
    tax: round(totals.tax),
    slippage: round(totals.slippage),
    total: round(total),
    tradeAmount: round(totals.tradeAmount),
    capitalImpact: round(total / initialCapital, 8),
    tradeCostRate: totals.tradeAmount ? round(total / totals.tradeAmount, 8) : 0
  };
}

function buildContributions(trades, holdings, assets, rules, initialCapital) {
  const catalog = new Map((assets || []).map((asset) => [asset.id, asset]));
  const rows = new Map();
  const ensureRow = (assetId, fallback = {}) => {
    if (!rows.has(assetId)) {
      const asset = catalog.get(assetId) || fallback;
      rows.set(assetId, {
        assetId,
        name: asset.name || assetId,
        industry: asset.industry || '待补充',
        amount: 0,
        buyAmount: 0,
        sellAmount: 0,
        tradeCount: 0
      });
    }
    return rows.get(assetId);
  };

  // 使用未计滑点的开盘参考金额归集证券价格贡献，佣金、税费和滑点留在成本项中单独核对。
  (trades || []).forEach((trade) => {
    const row = ensureRow(trade.assetId, trade);
    const costs = inferTradeCosts(trade, rules);
    row.tradeCount += 1;
    if (trade.side === 'buy') {
      row.amount -= costs.referenceAmount;
      row.buyAmount += costs.referenceAmount;
    } else {
      row.amount += costs.referenceAmount;
      row.sellAmount += costs.referenceAmount;
    }
  });

  (holdings || []).forEach((holding) => {
    const row = ensureRow(holding.assetId, holding);
    row.amount += Number(holding.marketValue || 0);
  });

  return [...rows.values()]
    .map((row) => ({
      ...row,
      amount: round(row.amount),
      contribution: round(row.amount / initialCapital, 8),
      buyAmount: round(row.buyAmount),
      sellAmount: round(row.sellAmount)
    }))
    .sort((left, right) => right.amount - left.amount || left.assetId.localeCompare(right.assetId));
}

function buildIndustryExposure(holdings, finalAsset) {
  const rows = new Map();
  (holdings || []).forEach((holding) => {
    const industry = holding.industry || '待补充';
    const current = rows.get(industry) || { industry, marketValue: 0, weight: 0, holdingCount: 0 };
    current.marketValue += Number(holding.marketValue || 0);
    current.weight += Number(holding.weight || 0);
    current.holdingCount += 1;
    rows.set(industry, current);
  });
  const items = [...rows.values()]
    .map((row) => ({ ...row, marketValue: round(row.marketValue), weight: round(row.weight, 8) }))
    .sort((left, right) => right.weight - left.weight || left.industry.localeCompare(right.industry, 'zh-CN'));
  const classifiedItems = items.filter((item) => item.industry !== '待补充');
  const stockWeights = (holdings || []).map((holding) => Number(holding.weight || 0));
  const classifiedWeight = classifiedItems.reduce((sum, item) => sum + item.weight, 0);
  const holdingsValue = (holdings || []).reduce((sum, holding) => sum + Number(holding.marketValue || 0), 0);
  return {
    rows: items,
    topFiveWeight: round([...stockWeights].sort((a, b) => b - a).slice(0, 5).reduce((sum, value) => sum + value, 0), 8),
    stockConcentration: round(stockWeights.reduce((sum, value) => sum + value ** 2, 0), 8),
    industryConcentration: classifiedWeight > 0
      ? round(classifiedItems.reduce((sum, item) => sum + item.weight ** 2, 0), 8)
      : null,
    classifiedWeight: round(classifiedWeight, 8),
    cashWeight: finalAsset ? round(Math.max(0, finalAsset - holdingsValue) / finalAsset, 8) : 0
  };
}

function movingAverage(points, endIndex, window) {
  if (endIndex < window - 1) return null;
  let total = 0;
  for (let index = endIndex - window + 1; index <= endIndex; index += 1) total += points[index].benchmark;
  return total / window;
}

function phaseMetrics(phase, label, returns, benchmarkReturns) {
  let nav = 1;
  let peak = 1;
  let maxDrawdown = 0;
  returns.forEach((value) => {
    nav *= 1 + value;
    peak = Math.max(peak, nav);
    maxDrawdown = Math.min(maxDrawdown, nav / peak - 1);
  });
  const benchmarkNav = benchmarkReturns.reduce((value, dailyReturn) => value * (1 + dailyReturn), 1);
  return {
    phase,
    label,
    days: returns.length,
    cumulativeReturn: round(nav - 1, 8),
    annualizedReturn: returns.length ? round(nav ** (252 / returns.length) - 1, 8) : null,
    volatility: returns.length > 1 ? round(sampleStd(returns) * Math.sqrt(252), 8) : null,
    maxDrawdown: round(maxDrawdown, 8),
    benchmarkReturn: round(benchmarkNav - 1, 8),
    excessReturn: round(nav - benchmarkNav, 8)
  };
}

function buildMarketPhases(points) {
  if (!Array.isArray(points) || points.length < 140) return [];
  const groups = {
    rising: { label: '上行阶段', returns: [], benchmarkReturns: [] },
    ranging: { label: '震荡阶段', returns: [], benchmarkReturns: [] },
    falling: { label: '下行阶段', returns: [], benchmarkReturns: [] }
  };

  // 阶段只用于事后归集：比较基准相对 120 日均线的位置，以及均线近 20 日的方向共同决定标签。
  for (let index = 139; index < points.length; index += 1) {
    const currentAverage = movingAverage(points, index, 120);
    const previousAverage = movingAverage(points, index - 20, 120);
    let phase = 'ranging';
    if (points[index].benchmark > currentAverage && currentAverage > previousAverage) phase = 'rising';
    if (points[index].benchmark < currentAverage && currentAverage < previousAverage) phase = 'falling';
    groups[phase].returns.push(points[index].nav / points[index - 1].nav - 1);
    groups[phase].benchmarkReturns.push(points[index].benchmark / points[index - 1].benchmark - 1);
  }

  return Object.entries(groups).map(([phase, group]) => phaseMetrics(phase, group.label, group.returns, group.benchmarkReturns));
}

function percentText(value, digits = 1) {
  return `${(Number(value || 0) * 100).toFixed(digits)}%`;
}

function buildDrawdownEpisode(points) {
  if (!Array.isArray(points) || !points.length) return null;
  let runningPeakIndex = 0;
  let episodePeakIndex = 0;
  let troughIndex = 0;
  let worstDrawdown = 0;

  points.forEach((point, index) => {
    if (point.nav > points[runningPeakIndex].nav) runningPeakIndex = index;
    const drawdown = point.nav / points[runningPeakIndex].nav - 1;
    if (drawdown < worstDrawdown) {
      worstDrawdown = drawdown;
      episodePeakIndex = runningPeakIndex;
      troughIndex = index;
    }
  });

  const peakNav = points[episodePeakIndex].nav;
  const recoveryOffset = points.slice(troughIndex + 1).findIndex((point) => point.nav >= peakNav);
  const recoveryIndex = recoveryOffset >= 0 ? troughIndex + 1 + recoveryOffset : null;
  return {
    peakDate: points[episodePeakIndex].date,
    troughDate: points[troughIndex].date,
    recoveryDate: recoveryIndex === null ? null : points[recoveryIndex].date,
    drawdown: round(worstDrawdown, 8),
    declineDays: troughIndex - episodePeakIndex,
    recoveryDays: recoveryIndex === null ? null : recoveryIndex - troughIndex
  };
}

function buildResultDiagnostics(result, analysis) {
  const points = result?.points || [];
  if (!points.length) return [];
  const startDate = points[0].date;
  const endDate = points.at(-1).date;
  const wholePeriod = `${startDate} 至 ${endDate}`;
  const items = [];

  const phases = (analysis.marketPhases || []).filter((item) => item.days > 0 && item.annualizedReturn !== null);
  if (phases.length >= 2) {
    const sortedPhases = [...phases].sort((left, right) => right.annualizedReturn - left.annualizedReturn);
    const best = sortedPhases[0];
    const worst = sortedPhases.at(-1);
    const spread = best.annualizedReturn - worst.annualizedReturn;
    items.push({
      id: 'market-phase',
      tone: spread >= 0.3 ? 'risk' : spread >= 0.15 ? 'caution' : 'neutral',
      title: `市场阶段差异达到 ${(spread * 100).toFixed(1)} 个百分点`,
      summary: `${best.label}年化收益为 ${percentText(best.annualizedReturn)}，${worst.label}为 ${percentText(worst.annualizedReturn)}，策略对市场环境较为敏感。`,
      period: wholePeriod,
      limitation: '阶段按比较基准事后划分，只用于解释历史表现，不参与信号计算。',
      nextStep: `保持其他规则不变，分别比较每周与${result.rules?.frequency === 'monthly' ? '每月' : '当前周期'}调整。`,
      evidenceTarget: 'marketPhaseSection',
      evidenceLabel: '市场阶段表现'
    });
  }

  const drawdown = buildDrawdownEpisode(points);
  if (drawdown) {
    const recoveredText = drawdown.recoveryDate
      ? `随后用 ${drawdown.recoveryDays} 个交易日恢复至前高`
      : `截至 ${endDate} 仍未恢复至前高`;
    items.push({
      id: 'drawdown',
      tone: drawdown.drawdown <= -0.3 ? 'risk' : drawdown.drawdown <= -0.15 ? 'caution' : 'neutral',
      title: `历史最大回撤 ${percentText(drawdown.drawdown)}`,
      summary: `净值从 ${drawdown.peakDate} 的阶段高点下行，在 ${drawdown.troughDate} 触及低点，${recoveredText}。`,
      period: `${drawdown.peakDate} 至 ${drawdown.recoveryDate || endDate}`,
      limitation: '这里只描述历史净值路径，未来回撤幅度和恢复时间可能不同。',
      nextStep: `保持其他规则不变，把单只上限从 ${Number(result.rules?.maxPosition || 0)}% 下调 5 个百分点后比较回撤。`,
      evidenceTarget: 'resultChartSection',
      evidenceLabel: '净值与回撤'
    });
  }

  const positiveContributions = (analysis.contributions || []).filter((item) => item.amount > 0);
  if (positiveContributions.length) {
    const totalPositive = positiveContributions.reduce((sum, item) => sum + item.amount, 0);
    const leader = positiveContributions[0];
    const leaderShare = totalPositive ? leader.amount / totalPositive : 0;
    const topFiveWeight = Number(analysis.industry?.topFiveWeight || 0);
    const concentrated = leaderShare >= 0.45 || topFiveWeight >= 0.8;
    items.push({
      id: 'concentration',
      tone: concentrated ? 'caution' : 'neutral',
      title: concentrated ? '收益与持仓存在集中现象' : '正贡献来源相对分散',
      summary: `${leader.name}占全部正贡献的 ${percentText(leaderShare)}；最新前五持仓权重为 ${percentText(topFiveWeight)}。`,
      period: `贡献区间 ${wholePeriod}；持仓截至 ${endDate}`,
      limitation: '证券贡献按价格变化归集，佣金、卖出税费和滑点在成本项单列。',
      nextStep: `保持其他规则不变，把目标持仓数从 ${Number(result.rules?.topCount || 0)} 只增加到 ${Number(result.rules?.topCount || 0) + 2} 只后比较。`,
      evidenceTarget: 'contributionSection',
      evidenceLabel: '证券贡献'
    });
  }

  const initialCapital = Number(result.initialCapital || INITIAL_CAPITAL);
  const extraCost = Number(analysis.costs?.commission || 0) + Number(analysis.costs?.slippage || 0);
  const extraCostImpact = initialCapital ? extraCost / initialCapital : 0;
  const estimatedReturn = Number(result.metrics?.cumulativeReturn || 0) - extraCostImpact;
  items.push({
    id: 'cost-sensitivity',
    tone: extraCostImpact >= 0.02 ? 'caution' : 'neutral',
    title: `费用上调一倍的静态影响约 ${(extraCostImpact * 100).toFixed(1)} 个百分点`,
    summary: `若佣金与滑点各提高一倍，累计收益静态估计将从 ${percentText(result.metrics?.cumulativeReturn)} 降至 ${percentText(estimatedReturn)}。`,
    period: wholePeriod,
    limitation: '这是保持成交记录不变的静态估计，没有重新计算调仓行为和成交数量。',
    nextStep: `保持其他规则不变，把滑点从 ${Number(result.rules?.slippageBps || 0)} 调到 ${Number(result.rules?.slippageBps || 0) + 5} 和 ${Number(result.rules?.slippageBps || 0) + 10} 后比较。`,
    evidenceTarget: 'costSection',
    evidenceLabel: '交易成本'
  });

  items.push({
    id: 'time-split',
    tone: 'pending',
    title: '尚未完成时间分段验证',
    summary: `当前 ${result.summary?.tradingDays || points.length} 个交易日作为一个完整区间计算，暂时无法判断规则在较新数据上的稳定性。`,
    period: wholePeriod,
    limitation: '完整区间结果同时参与规则观察和表现评价，可能高估历史适配后的稳定程度。',
    nextStep: '按时间前 70% 作为研究段、后 30% 作为验证段，规则保持不变分别计算。',
    evidenceTarget: 'resultProvenance',
    evidenceLabel: '结果与数据版本'
  });

  return items.slice(0, 5);
}

function buildResultAnalysis(result, assets = []) {
  if (!result || !Array.isArray(result.points) || !result.points.length) return null;
  const initialCapital = Number(result.initialCapital || INITIAL_CAPITAL);
  const finalAsset = Number(result.summary?.finalAsset || result.points.at(-1).asset || 0);
  const costs = buildCostBreakdown(result.trades || [], result.rules || {}, initialCapital);
  const contributions = buildContributions(result.trades || [], result.holdings || [], assets, result.rules || {}, initialCapital);
  const grossContribution = contributions.reduce((sum, item) => sum + item.amount, 0);
  const expectedProfit = finalAsset - initialCapital;
  const analysis = {
    annualReturns: buildAnnualReturns(result.points),
    contributions,
    industry: buildIndustryExposure(result.holdings || [], finalAsset),
    costs,
    marketPhases: buildMarketPhases(result.points),
    reconciliation: {
      grossContribution: round(grossContribution),
      costContribution: round(-costs.total),
      expectedProfit: round(expectedProfit),
      difference: round(grossContribution - costs.total - expectedProfit)
    }
  };
  analysis.diagnostics = buildResultDiagnostics(result, analysis);
  return analysis;
}

function ensureResultAnalysis(result, assets = []) {
  const rebuilt = buildResultAnalysis(result, assets);
  if (!rebuilt) return result?.analysis || null;
  if (!result?.analysis) return rebuilt;
  return {
    ...rebuilt,
    ...result.analysis,
    diagnostics: Array.isArray(result.analysis.diagnostics) && result.analysis.diagnostics.length
      ? result.analysis.diagnostics
      : rebuilt.diagnostics
  };
}

module.exports = {
  buildAnnualReturns,
  buildMarketPhases,
  buildResultAnalysis,
  buildResultDiagnostics,
  enrichTradesWithCosts,
  ensureResultAnalysis,
  inferTradeCosts
};
