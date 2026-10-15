const assert = require('assert');
const fs = require('fs');
const { defaultStrategy, runBacktest, validateStrategy } = require('../server/backtest');
const { buildLatestSignal, defaultRealStrategy, runRealBacktest, validateRealRules } = require('../server/real-backtest');
const { MARKET_FILE, normalizeRealDataset } = require('../server/market-data');
const { parseSearchPayload } = require('../server/instrument-search');
const {
  analyzeStock,
  buildFundingPlan,
  buildRadar,
  isEligibleQuote,
  normalizeRadarSettings,
  parseMarketPayload,
  parseNewsPayload,
  radarSnapshotQuality,
  resolveRadarSnapshot,
  validateRadarSettings
} = require('../server/market-radar');
const { buildAnnualReturns, buildMarketPhases, enrichTradesWithCosts } = require('../server/result-analysis');
const { publicState } = require('../server/store');
const {
  applyRadarAgentResult,
  buildRadarEvidence,
  buildStockEvidence,
  getAiAgentStatus,
  normalizeAgentResult,
  normalizeRadarAgentResult
} = require('../server/ai-agent');

function test(name, operation) {
  try {
    operation();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test('默认策略规则完整', () => {
  const strategy = defaultStrategy();
  assert.deepStrictEqual(validateStrategy(strategy.rules), []);
});

test('AI 研判开关默认启用并能持久化关闭状态', () => {
  assert.strictEqual(normalizeRadarSettings({}).aiEnabled, true);
  assert.strictEqual(normalizeRadarSettings({ aiEnabled: false }).aiEnabled, false);
  assert.strictEqual(normalizeRadarSettings({ aiEnabled: true }).aiEnabled, true);
});

test('权重合计错误会被拒绝', () => {
  const strategy = defaultStrategy();
  strategy.rules.weights.trend = 10;
  assert.ok(validateStrategy(strategy.rules).length > 0);
});

test('固定输入得到一致结果', () => {
  const rules = defaultStrategy().rules;
  const first = runBacktest(rules);
  const second = runBacktest(rules);
  assert.deepStrictEqual(first.metrics, second.metrics);
  assert.deepStrictEqual(first.points, second.points);
  assert.deepStrictEqual(
    first.trades.map(({ id, ...trade }) => trade),
    second.trades.map(({ id, ...trade }) => trade)
  );
});

test('每日资产和现金保持有效', () => {
  const result = runBacktest(defaultStrategy().rules);
  assert.ok(result.points.length > 400);
  assert.ok(result.points.every((point) => point.asset > 0 && point.cash >= 0 && point.nav > 0));
  assert.ok(result.summary.tradeCount > 0);
});

test('最大回撤处于有效范围', () => {
  const result = runBacktest(defaultStrategy().rules);
  assert.ok(result.metrics.maxDrawdown <= 0);
  assert.ok(result.metrics.maxDrawdown > -1);
});

test('年度收益按年度末净值连续计算', () => {
  const rows = buildAnnualReturns([
    { date: '2024-06-03', nav: 1.1, benchmark: 1.05 },
    { date: '2024-12-31', nav: 1.2, benchmark: 1.1 },
    { date: '2025-12-31', nav: 1.32, benchmark: 1.21 }
  ]);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].complete, false);
  assert.strictEqual(rows[0].strategyReturn, 0.2);
  assert.strictEqual(rows[1].strategyReturn, 0.1);
  assert.strictEqual(rows[1].benchmarkReturn, 0.1);
});

test('市场阶段使用足够历史后生成三类汇总', () => {
  const points = Array.from({ length: 180 }, (_, index) => ({
    date: `2025-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String(index % 28 + 1).padStart(2, '0')}`,
    nav: 1 + index * 0.001,
    benchmark: 1 + index * 0.0008
  }));
  const phases = buildMarketPhases(points);
  assert.deepStrictEqual(phases.map((item) => item.phase), ['rising', 'ranging', 'falling']);
  assert.strictEqual(phases.reduce((sum, item) => sum + item.days, 0), 41);
});

test('结果分析能够对齐最终盈亏', () => {
  const result = runBacktest(defaultStrategy().rules);
  assert.ok(result.analysis.annualReturns.length >= 2);
  assert.ok(result.analysis.contributions.length > 0);
  assert.ok(result.analysis.costs.total > 0);
  assert.ok(Math.abs(result.analysis.reconciliation.difference) < 2);
  assert.strictEqual(result.analysis.diagnostics.length, 5);
  assert.ok(result.analysis.diagnostics.every((item) => item.title && item.summary && item.evidenceTarget && item.nextStep));
  assert.ok(result.analysis.diagnostics.some((item) => item.id === 'time-split' && item.tone === 'pending'));
});

test('旧成交记录能够补齐逐笔费用明细', () => {
  const [sellTrade, buyTrade] = enrichTradesWithCosts([
    { side: 'sell', quantity: 1000, price: 9.995, amount: 9995, fee: 8 },
    { side: 'buy', quantity: 1000, price: 10.005, amount: 10005, fee: 5 }
  ], { slippageBps: 5 });
  assert.strictEqual(sellTrade.commission, 3);
  assert.strictEqual(sellTrade.tax, 5);
  assert.strictEqual(sellTrade.slippageCost, 5);
  assert.strictEqual(sellTrade.referenceAmount, 10000);
  assert.strictEqual(buyTrade.commission, 5);
  assert.strictEqual(buyTrade.tax, 0);
  assert.strictEqual(buyTrade.slippageCost, 5);
  assert.strictEqual(buyTrade.referencePrice, 10);
});

test('首页结果只匹配当前数据版本', () => {
  const state = {
    strategies: [],
    jobs: [
      { id: 'sample-job', resultId: 'sample-result' },
      { id: 'real-job', resultId: 'real-result' }
    ],
    results: [
      { id: 'sample-result', datasetId: 'sample-daily-v1' },
      { id: 'real-result', datasetId: 'real-daily-20260915' }
    ]
  };
  const visibleState = publicState(state, 'real-daily-20260915');
  assert.strictEqual(visibleState.latestResult.id, 'real-result');
  assert.deepStrictEqual(visibleState.jobs.map((job) => job.id), ['real-job']);
  assert.strictEqual(publicState(state, 'real-daily-missing').latestResult, null);
});

test('旧结果读取时能够补齐研究诊断', () => {
  const legacyResult = runBacktest(defaultStrategy().rules);
  delete legacyResult.analysis.diagnostics;
  const visibleState = publicState({ strategies: [], jobs: [], results: [legacyResult] }, legacyResult.datasetId);
  assert.strictEqual(visibleState.latestResult.analysis.diagnostics.length, 5);
  assert.ok(visibleState.latestResult.analysis.diagnostics.some((item) => item.evidenceTarget === 'resultChartSection'));
});

test('名称搜索只返回沪深证券', () => {
  const items = parseSearchPayload({
    QuotationCodeTable: {
      Data: [
        { Code: '000001', Name: '平安银行', Classify: 'AStock', MarketType: '2' },
        { Code: '601318', Name: '中国平安', Classify: 'AStock', MarketType: '1' },
        { Code: '01833', Name: '平安好医生', Classify: 'HK', MarketType: '5' }
      ]
    }
  });
  assert.deepStrictEqual(items, [
    { id: '000001', name: '平安银行', market: 'SZ' },
    { id: '601318', name: '中国平安', market: 'SH' }
  ]);
});

function radarQuote(code, name, sector, overrides = {}) {
  return {
    code,
    name,
    sector,
    price: 12,
    changePercent: 4,
    volume: 20_000_000,
    amount: 400_000_000,
    turnoverRate: 8,
    volumeRatio: 1.6,
    high: 12.4,
    low: 11.6,
    open: 11.8,
    previousClose: 11.54,
    marketValue: 8_000_000_000,
    floatMarketValue: 6_000_000_000,
    speed: 0,
    change60d: 18,
    changeYear: 25,
    listedDate: '2020-01-01',
    netInflow: 25_000_000,
    quoteTime: 1789718400,
    ...overrides
  };
}

test('短线范围排除不符合要求的证券', () => {
  const date = '2026-09-18';
  assert.strictEqual(isEligibleQuote(radarQuote('600001', '示例一', '通用设备'), date), true);
  assert.strictEqual(isEligibleQuote(radarQuote('300001', '示例五', '通用设备'), date), false);
  assert.strictEqual(isEligibleQuote(radarQuote('300001', '示例五', '通用设备'), date, { includeChiNext: true }), true);
  assert.strictEqual(isEligibleQuote(radarQuote('688001', '示例二', '半导体'), date), false);
  assert.strictEqual(isEligibleQuote(radarQuote('600002', 'ST示例', '通用设备'), date), false);
  assert.strictEqual(isEligibleQuote(radarQuote('600003', '示例三', '通用设备', { listedDate: '2026-08-01' }), date), false);
  assert.strictEqual(isEligibleQuote(radarQuote('600004', '示例四', '通用设备', { changePercent: 10, high: 12, low: 12 }), date), false);
  assert.strictEqual(isEligibleQuote(radarQuote('600005', '示例六', '通用设备', { price: 80 }), date), false);
});

test('全市场字段能够转为雷达快照', () => {
  const snapshot = parseMarketPayload({ data: { diff: [{
    f2: 12,
    f3: 4,
    f5: 1000,
    f6: 200_000_000,
    f8: 6,
    f10: 1.5,
    f12: '600001',
    f14: '示例一',
    f15: 12.2,
    f16: 11.4,
    f17: 11.6,
    f18: 11.54,
    f20: 8_000_000_000,
    f21: 6_000_000_000,
    f22: 0,
    f24: 16,
    f25: 20,
    f26: 20200101,
    f62: 10_000_000,
    f100: '通用设备',
    f124: 1789718400
  }] } });
  assert.strictEqual(snapshot.asOfDate, '2026-09-18');
  assert.strictEqual(snapshot.quotes[0].code, '600001');
  assert.strictEqual(snapshot.quotes[0].sector, '通用设备');
  assert.strictEqual(snapshot.quotes[0].floatMarketValue, 6_000_000_000);
});

test('盘前无效行情自动回退到最近有效快照', () => {
  const validSnapshot = {
    asOfDate: '2026-09-21',
    source: '测试数据',
    stale: false,
    quotes: Array.from({ length: 10 }, (_, index) => radarQuote(`600${String(index + 1).padStart(3, '0')}`, `样例${index + 1}`, '通用设备'))
  };
  const invalidSnapshot = {
    asOfDate: '2026-09-22',
    source: '测试数据',
    stale: false,
    quotes: validSnapshot.quotes.map((item) => ({ ...item, price: 0, amount: 0, turnoverRate: 0 }))
  };
  assert.strictEqual(radarSnapshotQuality(validSnapshot).usable, true);
  assert.strictEqual(radarSnapshotQuality(invalidSnapshot).usable, false);

  const resolved = resolveRadarSnapshot(invalidSnapshot, [], { snapshot: validSnapshot, news: [{ id: 'old-news' }] });
  assert.strictEqual(resolved.snapshot.asOfDate, '2026-09-21');
  assert.strictEqual(resolved.snapshot.stale, true);
  assert.strictEqual(resolved.shouldCache, false);
  assert.ok(resolved.snapshot.fallbackReason.includes('最近有效数据'));
  assert.deepStrictEqual(resolved.news, [{ id: 'old-news' }]);

  assert.throws(
    () => resolveRadarSnapshot(invalidSnapshot, [], { snapshot: invalidSnapshot, news: [] }),
    (error) => error.statusCode === 503 && error.message.includes('没有可回退')
  );
});

test('雷达生成三只跨板块候选并判断持仓', () => {
  const sectors = ['通用设备', '半导体', '电池'];
  const quotes = sectors.flatMap((sector, sectorIndex) => Array.from({ length: 6 }, (_, index) => radarQuote(
    `${sectorIndex === 1 ? '00' : '60'}${String(sectorIndex * 20 + index + 1).padStart(4, '0')}`,
    `${sector}样例${index + 1}`,
    sector,
    { changePercent: 7 - sectorIndex - index * 0.35, amount: 400_000_000 - index * 10_000_000 }
  )));
  const news = parseNewsPayload({ data: { list: [{
    code: 'n1',
    title: '制造业大会发布高端装备新进展',
    summary: '机器人与通用设备方向出现新进展',
    showTime: '2026-09-18 18:00:00',
    mediaName: '公开媒体',
    uniqueUrl: 'https://example.com/news/1'
  }] } });
  const radar = buildRadar({
    asOfDate: '2026-09-18',
    source: '测试数据',
    quotes
  }, news, [{ id: 'holding-1', code: quotes[0].code, name: quotes[0].name, quantity: 1000, cost: 10 }]);
  assert.strictEqual(radar.candidates.length, 3);
  assert.strictEqual(new Set(radar.candidates.map((item) => item.sector)).size, 3);
  assert.strictEqual(radar.news.length, 1);
  assert.ok(['继续持有', '做T条件'].includes(radar.holdings[0].action));
  assert.strictEqual(radar.scope.eligibleCount, 18);
  assert.ok(radar.candidatePool.length >= 3 && radar.candidatePool.length <= 12);
  assert.ok(radar.candidates.every((item) => item.funding.quantity >= 100 && item.funding.plannedAmount <= 8000));
});

test('高位过热证券不会进入普通候选池', () => {
  const sectors = ['通用设备', '半导体', '电池'];
  const quotes = sectors.flatMap((sector, sectorIndex) => Array.from({ length: 6 }, (_, index) => radarQuote(
    `60${String(sectorIndex * 100 + index + 1).padStart(4, '0')}`,
    `${sector}样例${index + 1}`,
    sector,
    index === 0 && sectorIndex === 0
      ? { price: 12.5, changePercent: 8.2, change60d: 52, high: 13, low: 11.5 }
      : { changePercent: 3.8 - index * 0.2, change60d: 12 + index }
  )));
  const hotCode = quotes[0].code;
  const radar = buildRadar({ asOfDate: '2026-09-18', source: '测试数据', quotes }, [], []);
  assert.ok(!radar.candidatePool.some((item) => item.code === hotCode));
  assert.ok(!radar.candidates.some((item) => item.code === hotCode));
  assert.ok(radar.overheatWatch.some((item) => item.code === hotCode));
  assert.ok(radar.overheatWatch.find((item) => item.code === hotCode).overheatReasons.length >= 2);
});

test('年度高位与阶段高位短回调都会触发回避', () => {
  const quotes = Array.from({ length: 6 }, (_, index) => radarQuote(
    `6006${String(index + 1).padStart(2, '0')}`,
    `位置样例${index + 1}`,
    '通用设备',
    index === 0
      ? { changePercent: 2.9, change60d: 22, changeYear: 134 }
      : { changePercent: 2.2 - index * 0.1, change60d: 10, changeYear: 20 }
  ));
  const snapshot = { asOfDate: '2026-09-18', source: '测试数据', quotes };
  const annualHigh = analyzeStock(snapshot, [], quotes[0].code);
  assert.strictEqual(annualHigh.decision, '过热回避');
  assert.ok(annualHigh.riskFlags.some((item) => item.includes('今年以来')));

  const pullbackQuotes = quotes.map((item, index) => index === 0 ? {
    ...item,
    changeYear: 38,
    change60d: 21,
    recentMetrics: {
      asOfDate: '2026-09-18',
      dataPoints: 60,
      return5d: -2,
      return10d: 6,
      return20d: 14,
      ma5: 11.8,
      ma10: 11.5,
      ma20: 11.1,
      ma20Deviation: 8.1,
      distanceTo20High: -3,
      distanceTo60High: -5,
      recentPeakAge: 2,
      pullbackDays: 2
    },
    historyStatus: 'ready'
  } : item);
  const shortPullback = analyzeStock({ ...snapshot, quotes: pullbackQuotes }, [], quotes[0].code);
  assert.strictEqual(shortPullback.decision, '过热回避');
  assert.ok(shortPullback.riskFlags.some((item) => item.includes('连续回调 2 天')));
});

test('市场分化时自动收缩重点候选数量', () => {
  const sectors = ['通用设备', '半导体', '电池'];
  const quotes = sectors.flatMap((sector, sectorIndex) => Array.from({ length: 6 }, (_, index) => radarQuote(
    `60${String(400 + sectorIndex * 100 + index + 1).padStart(4, '0')}`,
    `${sector}分化样例${index + 1}`,
    sector,
    { changePercent: index === 0 ? 3 : -2.2, change60d: index === 0 ? 12 : -5 }
  )));
  const radar = buildRadar({ asOfDate: '2026-09-18', source: '测试数据', quotes }, [], []);
  assert.ok(radar.mood.score < 50);
  assert.strictEqual(radar.selectionLimit, 1);
  assert.ok(radar.candidatePool.length >= 3);
  assert.strictEqual(radar.candidates.length, 1);
});

test('盘中快照只生成观察结论', () => {
  const quoteTime = Date.parse('2026-09-24T02:17:00.000Z') / 1000;
  const quotes = Array.from({ length: 6 }, (_, index) => radarQuote(
    `6005${String(index + 1).padStart(2, '0')}`,
    `盘中样例${index + 1}`,
    '通用设备',
    { quoteTime, changePercent: 3.8 - index * 0.2 }
  ));
  const radar = buildRadar({ asOfDate: '2026-09-24', source: '测试数据', quotes }, [], []);
  assert.strictEqual(radar.session.type, 'intraday');
  assert.ok(radar.candidates.every((item) => item.entryCondition.includes('盘中观察')));
});

test('AI 选择数量服从市场温度上限', () => {
  const sectors = ['通用设备', '半导体', '电池'];
  const quotes = sectors.flatMap((sector, sectorIndex) => Array.from({ length: 6 }, (_, index) => radarQuote(
    `60${String(700 + sectorIndex * 100 + index + 1).padStart(4, '0')}`,
    `${sector}温度样例${index + 1}`,
    sector,
    { changePercent: index === 0 ? 3 : -2.2, change60d: index === 0 ? 12 : -5 }
  )));
  const radar = buildRadar({ asOfDate: '2026-09-18', source: '测试数据', quotes }, [], []);
  const evidence = buildRadarEvidence(radar);
  const selections = evidence.candidates.slice(0, 3).map((item) => ({
    code: item.code,
    confidence: 70,
    reason: '通过规则候选池比较后保留观察。',
    evidenceIds: [item.id, 'MKT']
  }));
  const normalized = normalizeRadarAgentResult({
    summary: '按当前环境收缩候选数量。',
    marketView: '当前只适合少量观察。',
    selections,
    uncertainties: ['仍需后续确认']
  }, evidence);
  assert.strictEqual(evidence.filter.maxSelections, 1);
  assert.strictEqual(normalized.selections.length, 1);
});

test('AI 雷达只能在规则候选池内选择并重排', () => {
  const sectorNames = ['通用设备', '半导体', '电池', '通信设备'];
  const quotes = sectorNames.flatMap((sector, sectorIndex) => Array.from({ length: 6 }, (_, index) => radarQuote(
    `60${String(sectorIndex * 100 + index + 1).padStart(4, '0')}`,
    `${sector}候选${index + 1}`,
    sector,
    { changePercent: 6.8 - sectorIndex * 0.4 - index * 0.2, amount: 500_000_000 - index * 12_000_000 }
  )));
  const radar = buildRadar({ asOfDate: '2026-09-18', source: '测试数据', quotes }, [], []);
  const evidence = buildRadarEvidence(radar);
  assert.ok(evidence.candidates.length >= 6);
  assert.strictEqual(evidence.candidates[0].id, 'CAND-1');

  const selectedCodes = [evidence.candidates[2].code, evidence.candidates[0].code];
  const result = normalizeRadarAgentResult({
    summary: '方向与个股证据比较后调整了观察顺序。',
    marketView: '当前只适合按条件观察。',
    selections: selectedCodes.map((code, index) => ({
      code,
      confidence: 76 - index * 5,
      reason: `候选 ${index + 1} 的方向和量价证据更一致。`,
      evidenceIds: [evidence.candidates.find((item) => item.code === code).id, 'MKT']
    })),
    uncertainties: ['缺少下一交易日确认']
  }, evidence);
  const updated = applyRadarAgentResult(radar, {
    status: 'ready',
    version: 'radar-ai-agent-v1',
    generatedAt: '2026-09-18T10:00:00.000Z',
    asOfDate: radar.asOfDate,
    model: 'test-model',
    transport: 'responses',
    latencyMs: 20,
    result
  });
  assert.deepStrictEqual(updated.candidates.map((item) => item.code), selectedCodes);
  assert.strictEqual(updated.candidates[0].rankSource, 'ai');
  assert.ok(updated.candidates[0].aiReason);
  assert.strictEqual(updated.ai.status, 'ready');

  assert.throws(() => normalizeRadarAgentResult({
    summary: '无效结果',
    marketView: '无效结果',
    selections: [{ code: '999999', confidence: 99, reason: '不在候选池', evidenceIds: ['MKT'] }],
    uncertainties: ['无']
  }, evidence), /候选池之外/);
});

test('单股分析给出条件结论和资金计划', () => {
  const quotes = Array.from({ length: 6 }, (_, index) => radarQuote(
    `6000${String(index + 1).padStart(2, '0')}`,
    `通用设备样例${index + 1}`,
    '通用设备',
    { changePercent: 5 - index * 0.2 }
  ));
  const snapshot = { asOfDate: '2026-09-18', source: '测试数据', quotes };
  const analysis = analyzeStock(snapshot, [], quotes[0].code);
  assert.ok(['启动确认', '潜伏观察'].includes(analysis.decision));
  assert.strictEqual(analysis.personalFit, true);
  assert.strictEqual(analysis.sectorRank, 1);
  assert.ok(analysis.reasons.length >= 3);
  assert.ok(analysis.funding.quantity >= 100);
  assert.ok(analysis.entryCondition && analysis.invalidation);

  const highPriceQuotes = quotes.map((item, index) => index === 0
    ? { ...item, price: 88, previousClose: 85, low: 84.5, high: 89 }
    : item);
  const highPriceAnalysis = analyzeStock({ ...snapshot, quotes: highPriceQuotes }, [], quotes[0].code);
  assert.strictEqual(highPriceAnalysis.decision, '暂不考虑');
  assert.strictEqual(highPriceAnalysis.personalFit, false);
  assert.ok(highPriceAnalysis.issues.some((item) => item.includes('价格不在')));

  const hotQuotes = quotes.map((item, index) => index === 0
    ? { ...item, price: 12.5, changePercent: 8.2, change60d: 52, high: 13, low: 11.5 }
    : item);
  const hotAnalysis = analyzeStock({ ...snapshot, quotes: hotQuotes }, [], quotes[0].code);
  assert.strictEqual(hotAnalysis.decision, '过热回避');
  assert.strictEqual(hotAnalysis.personalFit, false);
  assert.ok(hotAnalysis.riskFlags.length >= 2);
});

test('AI 研判只使用编号证据并保留规则硬约束', () => {
  const quotes = Array.from({ length: 6 }, (_, index) => radarQuote(
    `6001${String(index + 1).padStart(2, '0')}`,
    `通用设备研判样例${index + 1}`,
    '通用设备',
    { changePercent: 5 - index * 0.2 }
  ));
  const analysis = analyzeStock({ asOfDate: '2026-09-18', source: '测试数据', quotes }, [{
    id: 'n1', title: '机器人与通用设备方向出现新进展', summary: '公开资料摘要', source: '公开媒体', publishedAt: '2026-09-18 18:00:00'
  }], quotes[0].code);
  const evidence = buildStockEvidence(analysis);
  assert.strictEqual(evidence.market.id, 'MKT');
  assert.strictEqual(evidence.rule.id, 'RULE');
  assert.strictEqual(evidence.news[0].id, 'NEWS-1');

  const normalized = normalizeAgentResult({
    verdict: '进入观察',
    confidence: 78.4,
    summary: '量价与方向形成一致支持。',
    ruleAlignment: '一致',
    signals: [
      { label: '市场', stance: '支持', detail: '市场温度允许观察。', evidenceIds: ['MKT'] },
      { label: '方向', stance: '支持', detail: '方向排名靠前。', evidenceIds: ['SECTOR'] },
      { label: '个股', stance: '谨慎', detail: '仍需核对次日表现。', evidenceIds: ['STOCK', 'UNKNOWN'] }
    ],
    newsView: '资讯与方向相关，但只能作为辅助。',
    entryChecklist: ['核对规则计划条件'],
    stopChecklist: ['跌破规则停止价格时放弃'],
    uncertainties: ['缺少交易时段内数据']
  }, evidence);
  assert.strictEqual(normalized.confidence, 78);
  assert.deepStrictEqual(normalized.signals[2].evidenceIds, ['STOCK']);

  const blocked = normalizeAgentResult({
    ...normalized,
    verdict: '进入观察',
    signals: normalized.signals
  }, { ...evidence, rule: { ...evidence.rule, personalFit: false } });
  assert.strictEqual(blocked.verdict, '暂不考虑');
});

test('AI 配置状态不暴露密钥内容', () => {
  const status = getAiAgentStatus({ OPENAI_API_KEY: 'local-secret', OPENAI_BASE_URL: 'https://example.com/v1', OPENAI_MODEL: 'example-model' });
  assert.deepStrictEqual(status, {
    enabled: true,
    model: 'example-model',
    mode: 'evidence-grounded-v1',
    message: '已配置，可生成证据化研判'
  });
  assert.strictEqual(JSON.stringify(status).includes('local-secret'), false);
});

test('资金方案同时受金额与计划损失限制', () => {
  const plan = buildFundingPlan(63, 59.8, {
    capital: 27000,
    cashReservePercent: 20,
    maxPositions: 3,
    maxSingleAmount: 8000,
    maxPositionPercent: 30,
    maxRiskPercent: 1.5
  });
  assert.strictEqual(plan.quantity, 100);
  assert.strictEqual(plan.plannedAmount, 6300);
  assert.strictEqual(plan.plannedLoss, 320);
  assert.ok(plan.positionPercent > 23 && plan.positionPercent < 24);
});

test('短线条件拒绝相反的价格和市值范围', () => {
  assert.ok(validateRadarSettings({ minPrice: 80, maxPrice: 70 }).length > 0);
  assert.ok(validateRadarSettings({ minFloatMarketCapYi: 300, maxFloatMarketCapYi: 200 }).length > 0);
});

if (fs.existsSync(MARKET_FILE)) {
  const marketPayload = JSON.parse(fs.readFileSync(MARKET_FILE, 'utf8'));
  const marketDataset = normalizeRealDataset(marketPayload);

  test('真实价格策略规则完整', () => {
    const strategy = defaultRealStrategy();
    assert.deepStrictEqual(validateRealRules(strategy.rules, marketDataset.assets.length), []);
  });

  test('真实数据版本包含稳定内容指纹', () => {
    const repeated = normalizeRealDataset(marketPayload);
    assert.match(marketDataset.metadata.id, /^real-daily-\d{8}-[a-f0-9]{8}$/);
    assert.strictEqual(marketDataset.metadata.id, repeated.metadata.id);
  });

  test('真实日线能够完成动态回测', () => {
    const rules = defaultRealStrategy().rules;
    const first = runRealBacktest(rules, marketDataset);
    const second = runRealBacktest(rules, marketDataset);
    assert.ok(first.datasetId.startsWith('real-daily-'));
    assert.ok(first.points.length > 900);
    assert.ok(first.summary.tradeCount > 0);
    assert.deepStrictEqual(first.metrics, second.metrics);
    assert.ok(first.points.every((point) => point.asset > 0 && point.cash >= 0));
    assert.ok(first.analysis.marketPhases.some((item) => item.days > 0));
    assert.ok(first.analysis.costs.commission > 0);
    assert.ok(Math.abs(first.analysis.reconciliation.difference) < 2);
  });

  test('月度策略区分观察预览和正式调整', () => {
    const rules = defaultRealStrategy().rules;
    const signal = buildLatestSignal(rules, marketDataset);
    assert.strictEqual(signal.asOfDate, marketDataset.dates.at(-1));
    assert.strictEqual(signal.mode, 'preview');
    assert.strictEqual(signal.referenceDate, '2026-08-31');
    assert.strictEqual(signal.selectedRows.length, Math.min(rules.topCount, signal.candidateCount));
    assert.ok(signal.selectedRows.every((item, index) => item.rank === index + 1));
    assert.strictEqual(signal.summary.addCount, signal.summary.removeCount);
    assert.ok(signal.watchRows.length <= 3);
  });

  test('每日策略在最新收盘形成正式信号', () => {
    const rules = { ...defaultRealStrategy().rules, frequency: 'daily' };
    const signal = buildLatestSignal(rules, marketDataset);
    assert.strictEqual(signal.mode, 'official');
    assert.strictEqual(signal.referenceDate, marketDataset.dates.at(-2));
    assert.ok(signal.nextAction.includes('下一交易日'));
  });
}

console.log('All checks passed');
