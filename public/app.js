(function () {
  const { icon } = window.LucideLite;
  const app = document.getElementById('app');
  const toastRegion = document.getElementById('toast-region');
  const defaultRadarSettings = {
    aiEnabled: true,
    capital: 27000,
    cashReservePercent: 20,
    maxPositions: 3,
    maxSingleAmount: 8000,
    maxPositionPercent: 30,
    maxRiskPercent: 1.5,
    minPrice: 3,
    maxPrice: 70,
    minFloatMarketCapYi: 30,
    maxFloatMarketCapYi: 200,
    maxTotalMarketCapYi: 300,
    minDailyAmountYi: 3,
    minTurnoverRate: 3,
    maxTurnoverRate: 20,
    minListedDays: 120,
    includeChiNext: false
  };

  const appState = {
    bootstrap: null,
    activePage: 'radar',
    activeTab: 'rules',
    ruleDraft: null,
    strategyName: '',
    idea: '选择盈利质量较好、估值合理且近期表现较强的股票，每月调整一次。',
    dirty: false,
    running: false,
    sidebarOpen: false,
    marketSelection: [],
    instrumentSuggestions: [],
    instrumentSearchTimer: null,
    instrumentSearchRequestId: 0,
    latestSignal: null,
    signalRulesKey: null,
    signalLoading: false,
    signalError: null,
    radarLoading: false,
    radarError: null,
    radarAiToggleLoading: false,
    radarAiToggleTarget: null,
    radarSettingsOpen: false,
    radarSettingsDraft: null,
    stockAnalysis: null,
    stockAiAnalysis: null,
    stockAiLoading: false,
    stockAnalysisCode: '',
    stockAnalysisQuery: '',
    stockAnalysisLoading: false,
    stockAnalysisError: null,
    stockAnalysisSuggestions: [],
    stockAnalysisSearchTimer: null,
    stockAnalysisSearchRequestId: 0,
    holdingFormOpen: false,
    holdingSuggestions: [],
    holdingSearchTimer: null,
    resultFilters: {
      tradeQuery: '',
      tradeSide: 'all',
      tradeFrom: '',
      tradeTo: '',
      tradeSortKey: 'date',
      tradeSortDirection: 'desc',
      tradePage: 1
    },
    error: null
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function defaultIdea(dataset) {
    return dataset?.kind === 'real'
      ? '选择趋势较强、波动较低且流动性较好的股票，每月调整一次，持有 5 只。'
      : '选择盈利质量较好、估值合理且近期表现较强的股票，每月调整一次。';
  }

  function formatPercent(value, digits = 2) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
    return `${(Number(value) * 100).toFixed(digits)}%`;
  }

  function formatMoney(value) {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency: 'CNY',
      maximumFractionDigits: 0
    }).format(Number(value || 0));
  }

  function formatNumber(value, digits = 2) {
    return new Intl.NumberFormat('zh-CN', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(Number(value || 0));
  }

  function formatDateTime(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(value));
  }

  function frequencyLabel(value) {
    return { daily: '每日', weekly: '每周', monthly: '每月' }[value] || value;
  }

  function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type === 'error' ? 'error' : ''}`;
    toast.innerHTML = `${icon(type === 'error' ? 'alert' : 'check', 17)}<span>${escapeHtml(message)}</span>`;
    toastRegion.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3200);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '本地服务未完成请求');
    return payload;
  }

  function getStrategy() {
    const preferredId = appState.bootstrap.dataset.kind === 'real' ? 'strategy-real-momentum' : 'strategy-quality-value';
    return appState.bootstrap.strategies.find((strategy) => strategy.id === preferredId) || appState.bootstrap.strategies[0];
  }

  function getCurrentVersion() {
    const strategy = getStrategy();
    return strategy.versions.find((version) => version.id === strategy.currentVersionId) || strategy.versions[0];
  }

  function validateDraft() {
    const rules = appState.ruleDraft;
    const errors = [];
    const total = Object.values(rules.weights).reduce((sum, value) => sum + Number(value || 0), 0);
    if (Math.abs(total - 100) > 0.001) errors.push(`排序权重当前合计 ${formatNumber(total, 0)}%，需要调整为 100%`);
    if (Number(rules.topCount) < 1 || Number(rules.topCount) > 40) {
      errors.push('目标持仓数量需要在 1 至 40 之间；可用证券不足时使用全部候选');
    }
    if (rules.strategyKind === 'price-factor-v1') {
      if (Number(rules.trendWindow) < 20 || Number(rules.trendWindow) > 250) errors.push('趋势观察期需要在 20 至 250 个交易日之间');
      if (Number(rules.volatilityWindow) < 10 || Number(rules.volatilityWindow) > 120) errors.push('波动观察期需要在 10 至 120 个交易日之间');
      if (Number(rules.minAverageAmount) < 0) errors.push('平均成交金额下限不能小于零');
    }
    if (Number(rules.maxPosition) <= 0 || Number(rules.maxPosition) > 100) errors.push('单只权重上限需要在 0% 至 100% 之间');
    if (Number(rules.cashReserve) < 0 || Number(rules.cashReserve) > 30) errors.push('现金保留比例需要在 0% 至 30% 之间');
    return errors;
  }

  function navButton(page, label, iconName, count = '') {
    return `
      <button class="nav-button ${appState.activePage === page ? 'active' : ''}" data-page="${page}" type="button">
        ${icon(iconName, 18)}
        <span>${label}</span>
        ${count !== '' ? `<span class="nav-count">${count}</span>` : ''}
      </button>`;
  }

  function renderShell() {
    const jobs = appState.bootstrap ? appState.bootstrap.jobs.length : 0;
    const dataContext = activeDataContext();
    app.innerHTML = `
      <div class="app-shell">
        <aside class="sidebar ${appState.sidebarOpen ? 'open' : ''}" id="sidebar">
          <div class="brand">
            <div>
              <div class="brand-wordmark">策研台</div>
              <div class="brand-meta">PERSONAL LAB</div>
            </div>
          </div>
          <nav class="sidebar-nav" aria-label="主要导航">
            ${navButton('radar', '短线雷达', 'signal')}
            ${navButton('strategy', '策略工作台', 'strategy')}
            ${navButton('signals', '每日信号', 'signal')}
            ${navButton('jobs', '回测任务', 'chart', jobs)}
            ${navButton('data', '数据状态', 'database')}
            ${navButton('settings', '本地设置', 'settings')}
          </nav>
          <div class="sidebar-foot">
            <strong>个人试用版 0.1</strong>
            <span>数据与结果只保存在本机</span>
          </div>
        </aside>
        ${appState.sidebarOpen ? '<button class="mobile-overlay" id="mobileOverlay" aria-label="关闭导航"></button>' : ''}
        <div class="main-shell">
          <header class="topbar">
            <div class="breadcrumb">
              <button class="button icon-only ghost mobile-menu" id="mobileMenu" type="button" aria-label="打开导航">${icon('menu', 19)}</button>
              <span>${pageTitle(appState.activePage)}</span>
              ${appState.activePage === 'strategy' && appState.bootstrap ? `${icon('chevron', 13)}<strong>${escapeHtml(appState.strategyName)}</strong>` : ''}
            </div>
            <div class="topbar-status">
              <span class="status-inline hide-mobile"><span class="status-dot"></span><span id="topbarDataDate">${escapeHtml(dataContext.date)}</span></span>
              <span class="status-inline">${icon('database', 14)}<span class="hide-mobile" id="topbarDataSource">${escapeHtml(dataContext.source)}</span></span>
            </div>
          </header>
          <main class="content" id="pageContent"></main>
        </div>
      </div>`;
    bindShellEvents();
    renderPage();
    app.setAttribute('aria-busy', 'false');
  }

  function pageTitle(page) {
    return { radar: '短线雷达', strategy: '策略', signals: '每日信号', jobs: '任务', data: '数据', settings: '设置' }[page] || '策研台';
  }

  function activeDataContext() {
    const dataset = appState.bootstrap?.dataset;
    if (appState.activePage === 'radar' && appState.bootstrap?.latestRadar) {
      const radar = appState.bootstrap.latestRadar;
      return {
        date: radar.asOfDate || dataset?.endDate || '读取中',
        source: radar.source || '全市场收盘行情'
      };
    }
    if (appState.activePage === 'signals' && appState.latestSignal) {
      return {
        date: appState.latestSignal.asOfDate || dataset?.endDate || '读取中',
        source: dataset?.name || '本地数据'
      };
    }
    return {
      date: dataset?.endDate || '读取中',
      source: dataset?.name || '本地数据'
    };
  }

  function refreshTopbarDataContext() {
    const context = activeDataContext();
    const date = document.getElementById('topbarDataDate');
    const source = document.getElementById('topbarDataSource');
    if (date) date.textContent = context.date;
    if (source) source.textContent = context.source;
  }

  function bindShellEvents() {
    document.querySelectorAll('[data-page]').forEach((button) => {
      button.addEventListener('click', () => {
        appState.activePage = button.dataset.page;
        appState.sidebarOpen = false;
        renderShell();
      });
    });
    document.getElementById('mobileMenu')?.addEventListener('click', () => {
      appState.sidebarOpen = true;
      renderShell();
    });
    document.getElementById('mobileOverlay')?.addEventListener('click', () => {
      appState.sidebarOpen = false;
      renderShell();
    });
  }

  function renderPage() {
    const content = document.getElementById('pageContent');
    if (!content) return;
    if (appState.activePage === 'radar') renderRadar(content);
    if (appState.activePage === 'strategy') renderWorkspace(content);
    if (appState.activePage === 'signals') renderSignals(content);
    if (appState.activePage === 'jobs') renderJobs(content);
    if (appState.activePage === 'data') renderData(content);
    if (appState.activePage === 'settings') renderSettings(content);
  }

  function renderWorkspace(content) {
    const strategy = getStrategy();
    const version = getCurrentVersion();
    const errors = validateDraft();
    content.innerHTML = `
      <div class="workspace-layout ${appState.activeTab === 'results' ? 'results-view' : ''}">
        <section class="workspace-main">
          <header class="page-header">
            <div class="page-title-wrap">
              <div class="page-eyebrow">当前策略</div>
              <div class="page-title-row">
                <h1 class="page-title">${escapeHtml(appState.strategyName)}</h1>
                <span class="version-label">${escapeHtml(version.label)}</span>
                <span class="state-label ${appState.dirty ? 'warning' : 'success'}">${appState.dirty ? '有修改' : '已保存'}</span>
              </div>
              <p class="page-subtitle">${escapeHtml(strategy.description)}</p>
            </div>
            <div class="page-actions">
              <button class="button" id="saveVersion" type="button" ${appState.running || !appState.dirty ? 'disabled' : ''}>${icon('save', 16)}保存版本</button>
              <button class="button primary" id="runBacktest" type="button" ${appState.running || errors.length ? 'disabled' : ''}>${appState.running ? '<span class="spinner" style="width:16px;height:16px"></span>运行中' : `${icon('play', 16)}运行回测`}</button>
            </div>
          </header>
          <div class="tabs" role="tablist" aria-label="策略视图">
            ${tabButton('rules', '策略规则')}
            ${tabButton('results', '运行结果')}
            ${tabButton('versions', '版本记录')}
          </div>
          <div id="workspaceBody">${workspaceBodyTemplate()}</div>
        </section>
        <aside class="context-panel" id="contextPanel">${contextPanelTemplate()}</aside>
      </div>`;
    bindWorkspaceEvents();
  }

  function tabButton(tab, label) {
    return `<button class="tab-button ${appState.activeTab === tab ? 'active' : ''}" data-tab="${tab}" role="tab" aria-selected="${appState.activeTab === tab}" type="button">${label}</button>`;
  }

  function workspaceBodyTemplate() {
    if (appState.running) {
      return `<div class="loading-panel"><div class="spinner"></div><strong>正在计算日频组合</strong><span>处理信号、成交、费用和每日资产</span></div>`;
    }
    if (appState.activeTab === 'rules') return rulesTemplate();
    if (appState.activeTab === 'results') return resultsTemplate(appState.bootstrap.latestResult);
    return versionsTemplate();
  }

  function rulesTemplate() {
    const rules = appState.ruleDraft;
    const errors = validateDraft();
    const weightTotal = Object.values(rules.weights).reduce((sum, value) => sum + Number(value || 0), 0);
    const isReal = rules.strategyKind === 'price-factor-v1';
    return `
      <div class="workspace-scroll">
        <section class="idea-panel">
          <div class="section-heading">
            <div><h2>从想法调整规则</h2><p>${isReal ? '本地解析趋势、稳定性、流动性和调仓描述' : '本地解析常见的质量、估值、趋势、波动和调仓描述'}</p></div>
          </div>
          <div class="idea-composer">
            <textarea id="ideaInput" aria-label="策略想法" placeholder="${isReal ? '例如：趋势较强、波动较低，每月调整，持有 5 只' : '例如：低估值、高质量、近期表现较强，每月调整，持有 6 只'}">${escapeHtml(appState.idea)}</textarea>
            <button class="button" id="applyIdea" type="button">${icon('spark', 16)}应用到规则</button>
          </div>
        </section>
        <div class="logic-track">
          ${isReal ? realRuleSteps(rules, errors, weightTotal) : sampleRuleSteps(rules, errors, weightTotal)}
          ${logicStep('03', '组合构建', `${rules.topCount} 只 · 等权`, `
            <div class="field-grid four">
              ${numberField('topCount', '目标持仓数量', rules.topCount, '只', 1, 40, 1)}
              ${numberField('maxPosition', '单只权重上限', rules.maxPosition, '%', 1, 100, 1)}
              ${numberField('cashReserve', '现金保留', rules.cashReserve, '%', 0, 30, 1)}
              <div class="field"><label for="weightingMode">分配方式</label><select id="weightingMode" disabled><option>等权</option></select></div>
            </div>`)}
          ${logicStep('04', '调仓与费用', `${frequencyLabel(rules.frequency)} · 次日开盘`, `
            <div class="field-grid four">
              <div class="field"><label for="frequency">调仓周期</label><select id="frequency" data-rule="frequency"><option value="daily" ${rules.frequency === 'daily' ? 'selected' : ''}>每日</option><option value="weekly" ${rules.frequency === 'weekly' ? 'selected' : ''}>每周</option><option value="monthly" ${rules.frequency === 'monthly' ? 'selected' : ''}>每月</option></select></div>
              ${numberField('commissionBps', '双边佣金', rules.commissionBps, '万分之一', 0, 100, 1)}
              ${numberField('slippageBps', '双边滑点', rules.slippageBps, '万分之一', 0, 100, 1)}
              <div class="field"><label for="executionTime">执行时点</label><select id="executionTime" disabled><option>下一交易日开盘</option></select></div>
            </div>`)}
        </div>
      </div>`;
  }

  function realRuleSteps(rules, errors, weightTotal) {
    return `
      ${logicStep('01', '证券范围', `${appState.bootstrap.dataset.instrumentCount} 只真实证券`, `
        <div class="field-grid">
          ${numberField('minAverageAmount', '20 日平均成交金额下限', rules.minAverageAmount, '百万元', 0, 10000, 10)}
          <div class="field"><label>数据价格口径</label><input value="${escapeHtml(appState.bootstrap.dataset.priceMode || '前复权')}" disabled /></div>
        </div>`)}
      ${logicStep('02', '动态排序', `当前合计 ${formatNumber(weightTotal, 0)}%`, `
        <div class="field-grid four">
          ${weightField('trend', '趋势', rules.weights.trend)}
          ${weightField('stability', '稳定性', rules.weights.stability)}
          ${weightField('liquidity', '流动性', rules.weights.liquidity)}
          ${numberField('trendWindow', '趋势观察期', rules.trendWindow, '交易日', 20, 250, 10)}
          ${numberField('volatilityWindow', '波动观察期', rules.volatilityWindow, '交易日', 10, 120, 5)}
        </div>
        <div class="validation-line ${errors.some((error) => error.includes('权重')) ? 'error' : ''}">${icon(errors.some((error) => error.includes('权重')) ? 'alert' : 'check', 15)}${errors.some((error) => error.includes('权重')) ? escapeHtml(errors.find((error) => error.includes('权重'))) : '每个调仓日重新计算分数和目标持仓'}</div>`)}
    `;
  }

  function sampleRuleSteps(rules, errors, weightTotal) {
    return `
      ${logicStep('01', '股票范围', '本地样例 · 12 只', `
        <div class="field-grid">
          ${numberField('minRoe', '净资产收益率下限', rules.minRoe, '%', 0, 50, 1)}
          ${numberField('maxPe', '市盈率上限', rules.maxPe, '倍', 5, 100, 1)}
        </div>`)}
      ${logicStep('02', '综合排序', `当前合计 ${formatNumber(weightTotal, 0)}%`, `
        <div class="field-grid four">
          ${weightField('valuation', '估值', rules.weights.valuation)}
          ${weightField('quality', '质量', rules.weights.quality)}
          ${weightField('trend', '趋势', rules.weights.trend)}
          ${weightField('stability', '稳定性', rules.weights.stability)}
        </div>
        <div class="validation-line ${errors.some((error) => error.includes('权重')) ? 'error' : ''}">${icon(errors.some((error) => error.includes('权重')) ? 'alert' : 'check', 15)}${errors.some((error) => error.includes('权重')) ? escapeHtml(errors.find((error) => error.includes('权重'))) : '权重合计正确，分数越高越优先'}</div>`)}
    `;
  }

  function logicStep(index, title, meta, body) {
    return `<section class="logic-step"><div class="step-index">${index}</div><div class="step-body"><div class="step-title"><h3>${title}</h3><span>${meta}</span></div>${body}</div></section>`;
  }

  function numberField(key, label, value, unit, min, max, step) {
    return `<div class="field"><label for="${key}">${label}<span class="unit">${unit}</span></label><input id="${key}" data-rule="${key}" type="number" value="${escapeHtml(value)}" min="${min}" max="${max}" step="${step}" /></div>`;
  }

  function weightField(key, label, value) {
    return `<div class="field"><label for="weight-${key}">${label}<span class="unit">%</span></label><div class="weight-field"><div class="weight-rail"><span id="bar-${key}" style="width:${Math.max(0, Math.min(100, value))}%"></span></div><input id="weight-${key}" data-weight="${key}" type="number" value="${escapeHtml(value)}" min="0" max="100" step="5" /></div></div>`;
  }

  function contextPanelTemplate() {
    const rules = appState.ruleDraft;
    const errors = validateDraft();
    const dataset = appState.bootstrap.dataset;
    const isReal = rules.strategyKind === 'price-factor-v1';
    return `
      <section class="context-section">
        <h2>当前策略摘要</h2>
        <dl class="summary-list">
          <div class="summary-row"><dt>候选范围</dt><dd>${dataset.instrumentCount} 只${dataset.kind === 'real' ? '真实证券' : '样例'}</dd></div>
          <div class="summary-row"><dt>筛选</dt><dd>${isReal ? `20 日平均成交金额 ≥ ${formatNumber(rules.minAverageAmount, 0)} 百万元` : `ROE ≥ ${formatNumber(rules.minRoe, 0)}%，PE ≤ ${formatNumber(rules.maxPe, 0)}`}</dd></div>
          ${isReal ? `<div class="summary-row"><dt>排序</dt><dd>趋势 ${rules.weights.trend}% / 稳定性 ${rules.weights.stability}% / 流动性 ${rules.weights.liquidity}%</dd></div>` : ''}
          <div class="summary-row"><dt>入选数量</dt><dd>${rules.topCount} 只</dd></div>
          <div class="summary-row"><dt>组合方式</dt><dd>等权，单只 ≤ ${rules.maxPosition}%</dd></div>
          <div class="summary-row"><dt>调仓</dt><dd>${frequencyLabel(rules.frequency)}，次日开盘</dd></div>
          <div class="summary-row"><dt>费用</dt><dd>佣金 ${rules.commissionBps} / 滑点 ${rules.slippageBps}</dd></div>
        </dl>
      </section>
      <section class="context-section">
        <h3>规则检查</h3>
        <div class="check-list">
          ${errors.length ? errors.map((error) => `<div class="check-row" style="color:var(--red)">${icon('alert', 15)}<span>${escapeHtml(error)}</span></div>`).join('') : `
            <div class="check-row">${icon('check', 15)}<span>字段与取值范围完整</span></div>
            <div class="check-row">${icon('check', 15)}<span>排序权重合计为 100%</span></div>
            <div class="check-row">${icon('check', 15)}<span>信号在收盘后计算</span></div>
            <div class="check-row">${icon('check', 15)}<span>成交安排在下一交易日</span></div>`}
        </div>
      </section>
      <section class="context-section">
        <h3>数据与区间</h3>
        <dl class="summary-list">
          <div class="summary-row"><dt>数据版本</dt><dd>${escapeHtml(dataset.id)}</dd></div>
          <div class="summary-row"><dt>研究区间</dt><dd>${escapeHtml(dataset.researchStartDate)}<br />至 ${escapeHtml(dataset.endDate)}</dd></div>
          <div class="summary-row"><dt>比较基准</dt><dd>${dataset.kind === 'real' ? '验证池等权组合' : '样例等权组合'}</dd></div>
          ${dataset.source ? `<div class="summary-row"><dt>数据来源</dt><dd>${escapeHtml(dataset.source)}</dd></div>` : ''}
        </dl>
      </section>
      <p class="data-note">${escapeHtml(dataset.note)}</p>`;
  }

  function resultsTemplate(result) {
    if (!result) {
      return `<div class="empty-state">${icon('chart', 34)}<h2>还没有运行结果</h2><p>规则确认后运行一次回测，这里会展示净值、回撤、持仓和成交。</p><button class="button primary" id="emptyRun" type="button">${icon('play', 16)}运行当前策略</button></div>`;
    }
    const metrics = result.metrics;
    const analysis = result.analysis || {};
    const industry = analysis.industry || { rows: [], classifiedWeight: 0, cashWeight: 0, topFiveWeight: 0, stockConcentration: 0, industryConcentration: null };
    const costs = analysis.costs || { commission: 0, tax: 0, slippage: 0, total: 0, capitalImpact: 0, tradeCostRate: 0 };
    const benchmarkLabel = result.datasetId.startsWith('real-daily-') ? '验证池等权' : '样例基准';
    return `
      <div class="metric-strip">
        ${metric('累计收益', metrics.cumulativeReturn, 'percent')}
        ${metric('年化收益', metrics.annualizedReturn, 'percent')}
        ${metric('最大回撤', metrics.maxDrawdown, 'percent')}
        ${metric('年化波动', metrics.volatility, 'percent')}
        ${metric('夏普比率', metrics.sharpe, 'number')}
        ${metric('累计超额', metrics.excessReturn, 'percent')}
        ${metric('年化换手', metrics.annualizedTurnover, 'percent')}
      </div>
      <div class="result-content">
        <section class="chart-section" id="resultChartSection">
          <div class="section-heading"><div><h2>净值与回撤</h2><p>${result.points[0].date} 至 ${result.points[result.points.length - 1].date} · ${result.summary.tradingDays} 个交易日</p></div><div class="chart-legend"><span class="legend-item"><i class="legend-line"></i>策略</span><span class="legend-item"><i class="legend-line benchmark"></i>${benchmarkLabel}</span></div></div>
          <div class="chart-frame">${lineChartSvg(result.points)}</div>
          <div class="chart-frame drawdown">${drawdownChartSvg(result.points)}</div>
        </section>
        <section class="analysis-section diagnosis-section" id="diagnosisSection">
          <div class="section-heading"><div><h2>研究诊断</h2><p>根据当前结果自动归纳，每条结论均可定位到计算证据</p></div><span class="state-label">规则诊断</span></div>
          ${diagnosticsTemplate(analysis.diagnostics || [])}
        </section>
        <div class="analysis-grid">
          <section class="analysis-section" id="annualReturnSection">
            <div class="section-heading"><div><h2>年度收益</h2><p>首尾年度按实际研究区间计算</p></div><button class="button compact" data-export="annual" type="button">导出 CSV</button></div>
            ${annualReturnsTable(analysis.annualReturns || [], benchmarkLabel)}
          </section>
          <section class="analysis-section">
            <div class="section-heading"><div><h2>月度收益</h2><p>最近 24 个自然月</p></div></div>
            <div class="monthly-grid">${result.monthlyReturns.slice(-24).map((item) => `<div class="month-cell ${item.value >= 0 ? 'up' : 'down'}"><time>${escapeHtml(item.month)}</time><strong>${formatPercent(item.value)}</strong></div>`).join('')}</div>
          </section>
        </div>
        <section class="analysis-section" id="marketPhaseSection">
          <div class="section-heading"><div><h2>市场阶段表现</h2><p>按比较基准的 120 日均线位置和近 20 日方向事后归集，不参与策略信号</p></div><button class="button compact" data-export="phases" type="button">导出 CSV</button></div>
          ${marketPhasesTable(analysis.marketPhases || [], benchmarkLabel)}
        </section>
        <div class="analysis-grid contribution-layout">
          <section class="analysis-section" id="contributionSection">
            <div class="section-heading"><div><h2>证券贡献</h2><p>价格贡献单独列示，交易成本不分摊到证券</p></div><button class="button compact" data-export="contributions" type="button">导出 CSV</button></div>
            ${contributionList(analysis.contributions || [])}
          </section>
          <section class="analysis-section" id="concentrationSection">
            <div class="section-heading"><div><h2>持仓集中度</h2><p>按最新收盘市值计算</p></div></div>
            ${industryExposureTemplate(industry)}
          </section>
        </div>
        <section class="analysis-section">
          <div class="section-heading"><div><h2>当前持仓</h2><p>按最新收盘市值排序</p></div><div class="section-actions"><span class="state-label">${result.holdings.length} 只</span><button class="button compact" data-export="holdings" type="button">导出 CSV</button></div></div>
          ${holdingsTable(result.holdings)}
        </section>
        <section class="analysis-section cost-section" id="costSection">
          <div class="section-heading"><div><h2>交易成本</h2><p>佣金、卖出税费和滑点分别核算</p></div><span class="state-label">占初始资金 ${formatPercent(costs.capitalImpact, 2)}</span></div>
          ${costBreakdownTemplate(costs)}
        </section>
        <section class="analysis-section" id="tradeDetailSection">
          ${tradeDetailTemplate(result)}
        </section>
        <section class="result-provenance" id="resultProvenance">
          <div><span>结果编号</span><strong>${escapeHtml(result.id)}</strong></div>
          <div><span>数据版本</span><strong>${escapeHtml(result.datasetId)}</strong></div>
          <div><span>计算版本</span><strong>${escapeHtml(result.engineVersion)}</strong></div>
          <div><span>完成时间</span><strong>${escapeHtml(formatDateTime(result.createdAt))}</strong></div>
        </section>
        ${Array.isArray(result.assumptions) ? `<p class="data-note">当前口径：${result.assumptions.map(escapeHtml).join('；')}。</p>` : ''}
      </div>`;
  }

  function metric(label, value, kind) {
    const numeric = Number(value);
    const display = kind === 'percent' ? formatPercent(value) : value === null ? '—' : formatNumber(value, 2);
    const tone = numeric > 0 ? 'positive' : numeric < 0 ? 'negative' : '';
    return `<div class="metric"><span class="metric-label">${label}</span><strong class="metric-value ${tone}">${display}</strong></div>`;
  }

  function diagnosticsTemplate(items) {
    if (!items.length) return '<div class="empty-state compact-empty"><p>当前结果不足以生成研究诊断</p></div>';
    const toneLabels = { risk: '高关注', caution: '需关注', neutral: '观察', pending: '待验证' };
    return `<div class="diagnosis-list">${items.map((item, index) => `
      <article class="diagnosis-item ${escapeHtml(item.tone)}">
        <div class="diagnosis-order"><span>${String(index + 1).padStart(2, '0')}</span><i aria-hidden="true"></i></div>
        <div class="diagnosis-copy">
          <div class="diagnosis-title-row"><span class="diagnosis-tone">${escapeHtml(toneLabels[item.tone] || toneLabels.neutral)}</span><h3>${escapeHtml(item.title)}</h3></div>
          <p>${escapeHtml(item.summary)}</p>
          <dl class="diagnosis-meta"><div><dt>适用区间</dt><dd>${escapeHtml(item.period)}</dd></div><div><dt>限制</dt><dd>${escapeHtml(item.limitation)}</dd></div></dl>
          <div class="diagnosis-next"><span>下一步验证</span><strong>${escapeHtml(item.nextStep)}</strong></div>
        </div>
        <button class="button compact ghost diagnosis-evidence" type="button" data-evidence-target="${escapeHtml(item.evidenceTarget)}">查看${escapeHtml(item.evidenceLabel)}</button>
      </article>`).join('')}</div>`;
  }

  function lineChartSvg(points) {
    const width = 1000;
    const height = 300;
    const padding = { left: 54, right: 18, top: 18, bottom: 30 };
    const values = points.flatMap((point) => [point.nav, point.benchmark]);
    const minValue = Math.min(...values) * 0.98;
    const maxValue = Math.max(...values) * 1.02;
    const x = (index) => padding.left + (index / Math.max(1, points.length - 1)) * (width - padding.left - padding.right);
    const y = (value) => padding.top + ((maxValue - value) / Math.max(0.0001, maxValue - minValue)) * (height - padding.top - padding.bottom);
    const pathFor = (key) => points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(2)},${y(point[key]).toFixed(2)}`).join(' ');
    const grid = Array.from({ length: 5 }, (_, index) => {
      const value = maxValue - (index / 4) * (maxValue - minValue);
      const position = y(value);
      return `<line class="chart-grid-line" x1="${padding.left}" y1="${position}" x2="${width - padding.right}" y2="${position}"/><text class="chart-axis-text" x="8" y="${position + 4}">${value.toFixed(2)}</text>`;
    }).join('');
    const labels = [0, Math.floor((points.length - 1) / 2), points.length - 1].map((index) => `<text class="chart-axis-text" x="${x(index)}" y="${height - 8}" text-anchor="${index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}">${points[index].date}</text>`).join('');
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="策略与基准净值曲线">${grid}<path class="chart-benchmark" d="${pathFor('benchmark')}"/><path class="chart-primary" d="${pathFor('nav')}"/>${labels}</svg>`;
  }

  function drawdownChartSvg(points) {
    const width = 1000;
    const height = 130;
    const padding = { left: 54, right: 18, top: 14, bottom: 24 };
    const minValue = Math.min(...points.map((point) => point.drawdown), -0.01);
    const x = (index) => padding.left + (index / Math.max(1, points.length - 1)) * (width - padding.left - padding.right);
    const y = (value) => padding.top + ((0 - value) / (0 - minValue)) * (height - padding.top - padding.bottom);
    const baseline = y(0);
    const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(2)},${y(point.drawdown).toFixed(2)}`).join(' ');
    const area = `${line} L${x(points.length - 1)},${baseline} L${x(0)},${baseline} Z`;
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="策略回撤曲线"><line class="chart-grid-line" x1="${padding.left}" y1="${baseline}" x2="${width - padding.right}" y2="${baseline}"/><text class="chart-axis-text" x="8" y="${padding.top + 4}">0%</text><text class="chart-axis-text" x="8" y="${height - padding.bottom}">${formatPercent(minValue, 1)}</text><path class="chart-drawdown" d="${area}"/></svg>`;
  }

  function holdingsTable(items) {
    if (!items.length) return '<div class="empty-state" style="min-height:180px"><p>当前没有持仓</p></div>';
    return `<div class="data-table-wrap"><table class="data-table"><thead><tr><th>证券</th><th>行业</th><th class="number">数量</th><th class="number">权重</th><th class="number">持有收益</th></tr></thead><tbody>${items.map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong><br><span style="color:var(--muted)">${escapeHtml(item.assetId)}</span></td><td>${escapeHtml(item.industry)}</td><td class="number">${item.quantity.toLocaleString('zh-CN')}</td><td class="number">${formatPercent(item.weight)}</td><td class="number" style="color:${item.returnSinceCost >= 0 ? 'var(--green-deep)' : 'var(--red)'}">${formatPercent(item.returnSinceCost)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function annualReturnsTable(items, benchmarkLabel) {
    if (!items.length) return '<div class="empty-state compact-empty"><p>年度收益暂不可计算</p></div>';
    return `<div class="data-table-wrap"><table class="data-table annual-table"><thead><tr><th>年度</th><th>区间</th><th class="number">策略</th><th class="number">${escapeHtml(benchmarkLabel)}</th><th class="number">差值</th></tr></thead><tbody>${[...items].reverse().map((item) => `<tr><td><strong>${escapeHtml(item.year)}</strong>${item.complete ? '' : '<span class="partial-tag">非完整</span>'}</td><td>${escapeHtml(item.startDate.slice(5))} 至 ${escapeHtml(item.endDate.slice(5))}</td><td class="number ${item.strategyReturn >= 0 ? 'positive-text' : 'negative-text'}">${formatPercent(item.strategyReturn)}</td><td class="number">${formatPercent(item.benchmarkReturn)}</td><td class="number ${item.excessReturn >= 0 ? 'positive-text' : 'negative-text'}">${formatPercent(item.excessReturn)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function marketPhasesTable(items, benchmarkLabel) {
    if (!items.length) return '<div class="empty-state compact-empty"><p>研究区间不足，暂时无法划分市场阶段</p></div>';
    return `<div class="data-table-wrap"><table class="data-table phase-table"><thead><tr><th>阶段</th><th class="number">交易日</th><th class="number">累计收益</th><th class="number">年化收益</th><th class="number">年化波动</th><th class="number">最大回撤</th><th class="number">${escapeHtml(benchmarkLabel)}</th><th class="number">差值</th></tr></thead><tbody>${items.map((item) => `<tr><td><span class="phase-mark ${escapeHtml(item.phase)}"></span><strong>${escapeHtml(item.label)}</strong></td><td class="number">${item.days}</td><td class="number ${item.cumulativeReturn >= 0 ? 'positive-text' : 'negative-text'}">${formatPercent(item.cumulativeReturn)}</td><td class="number">${formatPercent(item.annualizedReturn)}</td><td class="number">${formatPercent(item.volatility)}</td><td class="number negative-text">${formatPercent(item.maxDrawdown)}</td><td class="number">${formatPercent(item.benchmarkReturn)}</td><td class="number ${item.excessReturn >= 0 ? 'positive-text' : 'negative-text'}">${formatPercent(item.excessReturn)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function contributionList(items) {
    if (!items.length) return '<div class="empty-state compact-empty"><p>当前没有可归集的证券贡献</p></div>';
    const maximum = Math.max(...items.map((item) => Math.abs(item.amount)), 1);
    return `<div class="contribution-list">${items.map((item) => {
      const size = Math.max(1, Math.abs(item.amount) / maximum * 50);
      return `<div class="contribution-row"><div class="security-label"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.assetId)}</span></div><div class="contribution-track" aria-hidden="true"><i class="contribution-bar ${item.amount >= 0 ? 'positive' : 'negative'}" style="--bar-size:${size}%"></i></div><div class="contribution-value ${item.amount >= 0 ? 'positive-text' : 'negative-text'}"><strong>${formatMoney(item.amount)}</strong><span>${formatPercent(item.contribution)}</span></div></div>`;
    }).join('')}</div>`;
  }

  function industryExposureTemplate(industry) {
    const classified = Number(industry.classifiedWeight || 0) > 0;
    const metrics = `<div class="concentration-strip"><div><span>前五持仓</span><strong>${formatPercent(industry.topFiveWeight)}</strong></div><div><span>个股集中度</span><strong>${formatNumber(industry.stockConcentration, 3)}</strong></div><div><span>现金占比</span><strong>${formatPercent(industry.cashWeight)}</strong></div><div><span>行业集中度</span><strong>${classified ? formatNumber(industry.industryConcentration, 3) : '待补充'}</strong></div></div>`;
    if (!industry.rows.length) return `${metrics}<div class="empty-state compact-empty"><p>当前没有持仓</p></div>`;
    return `${metrics}<div class="industry-list">${industry.rows.map((item) => `<div class="industry-row"><div><strong>${escapeHtml(item.industry)}</strong><span>${item.holdingCount} 只</span></div><div class="industry-track"><i style="width:${Math.min(100, Math.max(0, item.weight * 100))}%"></i></div><strong>${formatPercent(item.weight)}</strong></div>`).join('')}</div>${classified ? '' : '<p class="inline-notice">当前行情源没有提供可靠的行业分类，因此不计算行业集中度。</p>'}`;
  }

  function costBreakdownTemplate(costs) {
    const items = [
      ['佣金', costs.commission],
      ['卖出税费', costs.tax],
      ['滑点成本', costs.slippage],
      ['合计', costs.total]
    ];
    return `<div class="cost-strip">${items.map(([label, value], index) => `<div class="cost-item ${index === items.length - 1 ? 'total' : ''}"><span>${label}</span><strong>${formatMoney(value)}</strong>${index === items.length - 1 ? `<small>成交金额占比 ${formatPercent(costs.tradeCostRate, 3)}</small>` : ''}</div>`).join('')}</div>`;
  }

  function filteredTrades(result) {
    const filters = appState.resultFilters;
    const query = filters.tradeQuery.trim().toLocaleLowerCase('zh-CN');
    const items = result.trades.filter((item) => {
      if (filters.tradeSide !== 'all' && item.side !== filters.tradeSide) return false;
      if (filters.tradeFrom && item.date < filters.tradeFrom) return false;
      if (filters.tradeTo && item.date > filters.tradeTo) return false;
      if (query && !`${item.name} ${item.assetId}`.toLocaleLowerCase('zh-CN').includes(query)) return false;
      return true;
    });
    const direction = filters.tradeSortDirection === 'asc' ? 1 : -1;
    return items.sort((left, right) => {
      const leftValue = left[filters.tradeSortKey];
      const rightValue = right[filters.tradeSortKey];
      if (typeof leftValue === 'number' && typeof rightValue === 'number') return (leftValue - rightValue) * direction;
      return String(leftValue).localeCompare(String(rightValue), 'zh-CN') * direction;
    });
  }

  function tradeDetailTemplate(result) {
    const filters = appState.resultFilters;
    const items = filteredTrades(result);
    return `<div class="section-heading"><div><h2>成交明细</h2><p>费用已经计入组合资产；筛选后的记录可直接导出</p></div><div class="section-actions"><span class="state-label" id="tradeCount">${items.length} / ${result.summary.tradeCount} 笔</span><button class="button compact" id="exportTrades" type="button">导出 CSV</button></div></div>
      <div class="detail-toolbar" aria-label="成交筛选">
        <label class="search-field">${icon('search', 15)}<input id="tradeQuery" value="${escapeHtml(filters.tradeQuery)}" placeholder="证券名称或代码" aria-label="搜索成交证券" /></label>
        <label><span>方向</span><select id="tradeSide"><option value="all" ${filters.tradeSide === 'all' ? 'selected' : ''}>全部</option><option value="buy" ${filters.tradeSide === 'buy' ? 'selected' : ''}>买入</option><option value="sell" ${filters.tradeSide === 'sell' ? 'selected' : ''}>卖出</option></select></label>
        <label><span>开始日期</span><input id="tradeFrom" type="date" value="${escapeHtml(filters.tradeFrom)}" /></label>
        <label><span>结束日期</span><input id="tradeTo" type="date" value="${escapeHtml(filters.tradeTo)}" /></label>
        <button class="button compact ghost" id="clearTradeFilters" type="button">清除</button>
      </div>
      <div class="trade-table-host">${tradeTableHostTemplate(items)}</div>`;
  }

  function tradeTableHostTemplate(items) {
    const pageSize = 50;
    const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
    appState.resultFilters.tradePage = Math.min(Math.max(1, appState.resultFilters.tradePage), pageCount);
    const page = appState.resultFilters.tradePage;
    const start = (page - 1) * pageSize;
    const visibleItems = items.slice(start, start + pageSize);
    const rangeText = items.length ? `${start + 1}–${start + visibleItems.length}` : '0';
    return `${tradesTable(visibleItems, true)}<div class="table-pagination"><span>显示 ${rangeText}，共 ${items.length} 笔</span><div><button class="button compact ghost" data-trade-page="${page - 1}" type="button" ${page <= 1 ? 'disabled' : ''}>上一页</button><span>${page} / ${pageCount}</span><button class="button compact ghost" data-trade-page="${page + 1}" type="button" ${page >= pageCount ? 'disabled' : ''}>下一页</button></div></div>`;
  }

  function tradeSortButton(key, label) {
    const active = appState.resultFilters.tradeSortKey === key;
    const marker = active ? (appState.resultFilters.tradeSortDirection === 'asc' ? '↑' : '↓') : '';
    return `<button class="table-sort ${active ? 'active' : ''}" data-trade-sort="${key}" type="button">${label}<span>${marker}</span></button>`;
  }

  function tradesTable(items, sortable = false) {
    if (!items.length) return '<div class="empty-state" style="min-height:180px"><p>当前没有成交记录</p></div>';
    return `<div class="data-table-wrap"><table class="data-table"><thead><tr><th>${sortable ? tradeSortButton('date', '日期') : '日期'}</th><th>方向</th><th>${sortable ? tradeSortButton('name', '证券') : '证券'}</th><th class="number">数量</th><th class="number">成交价</th><th class="number">${sortable ? tradeSortButton('amount', '成交金额') : '成交金额'}</th><th class="number">费用</th></tr></thead><tbody>${items.map((item) => `<tr><td>${escapeHtml(item.date)}</td><td><span class="trade-side ${item.side}">${item.side === 'buy' ? '买入' : '卖出'}</span></td><td>${escapeHtml(item.name)} <span style="color:var(--muted)">${escapeHtml(item.assetId)}</span></td><td class="number">${item.quantity.toLocaleString('zh-CN')}</td><td class="number">${formatNumber(item.price, 3)}</td><td class="number">${formatMoney(item.amount)}</td><td class="number">${formatMoney(item.fee)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function versionsTemplate() {
    const strategy = getStrategy();
    return `<div class="workspace-scroll"><div class="section-heading"><div><h2>版本记录</h2><p>每个版本都保存完整规则，历史记录不会被当前修改覆盖</p></div></div><div class="data-table-wrap"><table class="data-table"><thead><tr><th>版本</th><th>说明</th><th>创建时间</th><th>持仓</th><th>调仓</th><th></th></tr></thead><tbody>${strategy.versions.map((version) => `<tr><td><strong>${escapeHtml(version.label)}</strong>${version.id === strategy.currentVersionId ? ' <span class="state-label success">当前</span>' : ''}</td><td>${escapeHtml(version.note)}</td><td>${formatDateTime(version.createdAt)}</td><td>${version.rules.topCount} 只</td><td>${frequencyLabel(version.rules.frequency)}</td><td class="number"><button class="button version-load" data-version-id="${escapeHtml(version.id)}" type="button">载入规则</button></td></tr>`).join('')}</tbody></table></div></div>`;
  }

  function formatCompactAmount(value) {
    const amount = Number(value || 0);
    if (amount >= 100_000_000) return `${formatNumber(amount / 100_000_000, 1)} 亿`;
    if (amount >= 10_000) return `${formatNumber(amount / 10_000, 0)} 万`;
    return formatNumber(amount, 0);
  }

  function signedPercent(value) {
    const number = Number(value || 0);
    return `${number > 0 ? '+' : ''}${formatNumber(number, 2)}%`;
  }

  function radarActionMarkup(action, tone) {
    return `<span class="radar-action ${escapeHtml(tone)}">${escapeHtml(action)}</span>`;
  }

  function factorScoresMarkup(factorScores) {
    if (!factorScores) return '';
    const factorLabels = {
      position: ['位置', '25%'],
      trend: ['趋势', '18%'],
      volume: ['量能', '17%'],
      sector: ['板块', '15%'],
      structure: ['结构', '10%'],
      market: ['市场', '10%'],
      liquidity: ['流动性', '5%']
    };
    return `<div class="candidate-factors">${Object.entries(factorLabels).map(([key, label]) => `<div><span>${label[0]} <small>${label[1]}</small></span><strong>${formatNumber(factorScores[key], 0)}</strong><i><b style="width:${Math.max(0, Math.min(100, Number(factorScores[key]) || 0))}%"></b></i></div>`).join('')}</div>`;
  }

  function candidateMarkup(item, index) {
    const funding = item.funding;
    return `
      <article class="candidate-row">
        <div class="candidate-rank"><span>${item.rankSource === 'ai' ? 'AI 顺序' : '重点'}</span><strong>0${index + 1}</strong></div>
        <div class="candidate-identity">
          <div class="candidate-name"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.code)}</span></div>
          <div class="candidate-quote"><strong>${formatNumber(item.price, 2)}</strong><span class="${item.changePercent >= 0 ? 'quote-up' : 'quote-down'}">${signedPercent(item.changePercent)}</span></div>
          <div class="candidate-meta"><span>${escapeHtml(item.sector)} · 热度第 ${item.sectorRank}</span><span>换手 ${formatNumber(item.turnoverRate, 1)}%</span><span>成交 ${formatCompactAmount(item.amount)}</span>${item.recentMetrics ? `<span>近20日 ${signedPercent(item.recentMetrics.return20d)} · 距高点 ${signedPercent(item.recentMetrics.distanceTo20High)}</span>` : `<span>今年以来 ${signedPercent(item.changeYear)}</span>`}${item.floatMarketValue ? `<span>流通市值 ${formatNumber(item.floatMarketValue / 100_000_000, 0)} 亿</span>` : ''}</div>
        </div>
        <div class="candidate-score"><span class="candidate-risk-gate ${item.riskGate === 'passed' ? 'passed' : ''}">${item.riskGate === 'passed' ? '风险门已通过' : '旧规则结果'}</span><span>综合分</span><strong>${formatNumber(item.score, 0)}</strong></div>
        <div class="candidate-plan">
          <div class="candidate-plan-head">${radarActionMarkup(item.action, item.actionTone)}<span>条件满足才观察</span></div>
          <p><strong>计划条件</strong>${escapeHtml(item.entryCondition)}</p>
          <p class="candidate-stop"><strong>失效条件</strong>${escapeHtml(item.invalidation)}</p>
        </div>
        ${factorScoresMarkup(item.factorScores)}
        ${funding ? `<div class="candidate-funding"><div><span>建议数量</span><strong>${funding.quantity} 股</strong></div><div><span>预计占用</span><strong>${formatMoney(funding.plannedAmount)}</strong></div><div><span>账户占比</span><strong>${formatNumber(funding.positionPercent, 1)}%</strong></div><div><span>计划最大损失</span><strong>${formatMoney(funding.plannedLoss)}</strong><small>${formatNumber(funding.riskPercent, 2)}% · 受${escapeHtml(funding.limitingFactor)}约束</small></div></div>` : ''}
        ${item.aiReason ? `<div class="candidate-ai-reason"><span>${icon('spark', 15)}</span><div><strong>AI 入选理由 · 置信度 ${formatNumber(item.aiConfidence, 0)}</strong><p>${escapeHtml(item.aiReason)}</p><small>${(item.aiEvidenceIds || []).map(escapeHtml).join(' · ')}</small></div></div>` : ''}
        <details class="candidate-reasons"><summary>查看入选依据</summary><ul>${item.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul></details>
      </article>`;
  }

  function radarAiToggleMarkup(settings) {
    const enabled = settings.aiEnabled !== false;
    const loading = appState.radarAiToggleLoading;
    const label = loading
      ? (appState.radarAiToggleTarget ? '正在启用' : '正在关闭')
      : (enabled ? '已启用' : '已禁用');
    return `
      <button class="button radar-ai-toggle ${enabled ? 'enabled' : ''}" id="toggleRadarAi" type="button" role="switch" aria-checked="${enabled}" aria-busy="${loading}" aria-label="${enabled ? '禁用' : '启用'} AI 研判" ${loading || appState.radarLoading ? 'disabled' : ''}>
        <span class="radar-ai-toggle-track" aria-hidden="true"><span></span></span>
        <span class="radar-ai-toggle-title">AI 研判</span>
        <strong>${label}</strong>
      </button>`;
  }

  function radarAiStatusMarkup(radar) {
    if (appState.radarAiToggleLoading) {
      return `<div class="radar-ai-status running"><span class="spinner"></span><div><strong>正在${appState.radarAiToggleTarget ? '启用' : '关闭'} AI 研判</strong><p>使用当前缓存行情重新整理候选，不会重新下载市场数据。</p></div></div>`;
    }
    if (appState.radarLoading) {
      return `<div class="radar-ai-status running"><span class="spinner"></span><div><strong>AI 正在比较规则候选池</strong><p>刷新行情后，会在符合你资金和筛选条件的候选中重新排序。</p></div></div>`;
    }
    const ai = radar.ai;
    const settings = appState.bootstrap?.radarSettings || radar.settings || defaultRadarSettings;
    if (settings.aiEnabled === false || ai?.status === 'disabled') {
      return `<div class="radar-ai-status disabled"><span class="radar-ai-status-mark">${icon('spark', 17)}</span><div><strong>AI 研判已关闭</strong><p>${escapeHtml(ai?.message || '当前名单和单股分析只使用固定规则，不会调用 AI。')}</p></div></div>`;
    }
    if (ai?.status === 'ready') {
      return `<div class="radar-ai-status ready"><span class="radar-ai-status-mark">${icon('spark', 17)}</span><div><strong>AI 已参与本次排序</strong><p>${escapeHtml(ai.summary)}</p><small>${escapeHtml(ai.model)} · 从 ${ai.ruleCandidateCount} 只规则候选中选择 ${ai.selectedCount} 只 · ${formatDateTime(ai.generatedAt)}</small></div></div>`;
    }
    const agentEnabled = appState.bootstrap?.aiAgent?.enabled;
    const message = ai?.message || (agentEnabled
      ? '当前保存的是旧版规则结果，点击更新雷达后会调用 AI 比较候选。'
      : 'AI 尚未配置，本次沿用规则排序结果。');
    return `<div class="radar-ai-status fallback"><span class="radar-ai-status-mark">${icon('alert', 17)}</span><div><strong>${ai?.status === 'error' ? '本次沿用规则结果' : '当前为规则排序'}</strong><p>${escapeHtml(message)}</p>${ai?.model ? `<small>计划模型 ${escapeHtml(ai.model)}</small>` : ''}</div></div>`;
  }

  function holdingRowsMarkup(rows) {
    if (!rows.length) {
      return `<div class="radar-empty"><strong>还没有持仓</strong><span>添加证券、数量和成本后，这里会给出继续持有、退出或做T的条件。</span></div>`;
    }
    return `<div class="holding-list">${rows.map((item) => `
      <div class="holding-row">
        <div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.code)} · ${escapeHtml(item.sector || '板块待更新')}</span></div>
        <div class="holding-number"><span>现价</span><strong>${item.price ? formatNumber(item.price, 2) : '—'}</strong></div>
        <div class="holding-number"><span>持仓收益</span><strong class="${Number(item.profitPercent) >= 0 ? 'quote-up' : 'quote-down'}">${item.profitPercent === null || item.profitPercent === undefined ? '—' : signedPercent(item.profitPercent)}</strong></div>
        <div class="holding-number"><span>参考市值</span><strong>${item.marketValue ? formatMoney(item.marketValue) : '—'}</strong></div>
        <div class="holding-decision">${radarActionMarkup(item.action, item.actionTone)}<p>${escapeHtml(item.note)}</p></div>
        <button class="button icon-only ghost" type="button" data-remove-holding="${escapeHtml(item.id)}" aria-label="移除 ${escapeHtml(item.name)}">${icon('close', 16)}</button>
      </div>`).join('')}</div>`;
  }

  function holdingFormMarkup() {
    if (!appState.holdingFormOpen) return '';
    return `
      <form class="holding-form" id="holdingForm">
        <div class="holding-search-field">
          <label for="holdingSearch">证券名称或代码</label>
          <div class="instrument-search-wrap">
            ${icon('search', 16)}
            <input id="holdingSearch" autocomplete="off" placeholder="例如：平安银行" aria-expanded="false" />
            <input id="holdingCode" type="hidden" />
            <div class="instrument-suggestions" id="holdingSuggestions" role="listbox" hidden></div>
          </div>
        </div>
        <label>持有数量<input id="holdingQuantity" type="number" min="1" step="1" placeholder="例如 1000" required /></label>
        <label>成本价<input id="holdingCost" type="number" min="0.001" step="0.001" placeholder="例如 12.680" required /></label>
        <div class="holding-form-actions"><button class="button" id="cancelHolding" type="button">取消</button><button class="button primary" type="submit">保存持仓</button></div>
      </form>`;
  }

  function radarHistoryMarkup(history) {
    if (!history.length) return '<div class="radar-empty"><span>生成首份名单后，这里会开始记录后续表现。</span></div>';
    const cells = (performance) => ['day1', 'day3', 'day5'].map((key) => {
      const value = performance?.[key];
      return `<td class="number ${Number(value) >= 0 ? 'quote-up' : 'quote-down'}">${value === null || value === undefined ? '观察中' : formatPercent(value)}</td>`;
    }).join('');
    const rows = history.slice(0, 5).flatMap((record) => record.candidates.map((item) => `
      <tr><td>${escapeHtml(record.asOfDate)}</td><td><strong>${escapeHtml(item.name)}</strong> <span class="security-code">${escapeHtml(item.code)}</span></td><td>${escapeHtml(item.action)}</td><td class="number">${formatNumber(item.referencePrice, 2)}</td>${cells(item.performance)}</tr>`)).join('');
    return `<div class="data-table-wrap"><table class="data-table radar-history-table"><thead><tr><th>入选日</th><th>证券</th><th>当日计划</th><th class="number">参考价</th><th class="number">后 1 日</th><th class="number">后 3 日</th><th class="number">后 5 日</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function previousCandidatesMarkup(record) {
    if (!record?.candidates?.length) {
      return '<div class="radar-empty"><strong>当前没有可用的重点候选</strong><span>本机尚未保存可回退的有效名单，请在行情恢复后重新更新。</span></div>';
    }
    return `
      <div class="previous-candidates">
        <div class="previous-candidates-heading"><div><strong>沿用 ${escapeHtml(record.asOfDate)} 最近有效候选</strong><span>当前完整行情未就绪，仅保留旧计划供核对，不代表今天已重新计算。</span></div><span class="state-label warning">历史计划</span></div>
        ${record.candidates.map((item, index) => `<div class="previous-candidate-row"><span>${String(index + 1).padStart(2, '0')}</span><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.code)} · ${escapeHtml(item.sector || '方向待更新')}</small></div><div><small>当日计划</small><strong>${escapeHtml(item.action)}</strong></div><div><small>参考价</small><strong>${formatNumber(item.referencePrice, 2)}</strong></div></div>`).join('')}
      </div>`;
  }

  function radarProfileMarkup(settings) {
    const available = settings.capital * (1 - settings.cashReservePercent / 100);
    const plannedLoss = settings.capital * settings.maxRiskPercent / 100;
    return `
      <section class="radar-profile-bar">
        <div class="profile-capital"><span>我的资金方案</span><strong>${formatMoney(settings.capital)}</strong><small>可安排 ${formatMoney(available)}</small></div>
        <div class="profile-rule"><span>单只金额</span><strong>不超过 ${formatMoney(settings.maxSingleAmount)}</strong></div>
        <div class="profile-rule"><span>持仓数量</span><strong>最多 ${settings.maxPositions} 只</strong></div>
        <div class="profile-rule"><span>价格范围</span><strong>${formatNumber(settings.minPrice, 0)} 至 ${formatNumber(settings.maxPrice, 0)} 元</strong></div>
        <div class="profile-rule"><span>流通市值</span><strong>${formatNumber(settings.minFloatMarketCapYi, 0)} 至 ${formatNumber(settings.maxFloatMarketCapYi, 0)} 亿</strong></div>
        <div class="profile-rule"><span>计划最大损失</span><strong>${formatMoney(plannedLoss)}</strong></div>
        <button class="button" id="toggleRadarSettings" type="button">${icon('tune', 16)}筛选设置</button>
      </section>`;
  }

  function radarSettingsMarkup(settings) {
    if (!appState.radarSettingsOpen) return '';
    return `
      <section class="page-band radar-settings-panel">
        <form id="radarSettingsForm">
          <div class="settings-group-heading"><div><h2>我的资金方案</h2><p>按资金、仓位和计划损失中更严格的一项计算建议股数</p></div></div>
          <div class="radar-settings-grid funding-settings">
            <label>账户资金<input id="settingCapital" type="number" min="5000" step="1000" value="${settings.capital}" required /><small>元</small></label>
            <label>预留现金<input id="settingCashReserve" type="number" min="0" max="80" step="1" value="${settings.cashReservePercent}" required /><small>%</small></label>
            <label>最多持有<input id="settingMaxPositions" type="number" min="1" max="10" step="1" value="${settings.maxPositions}" required /><small>只</small></label>
            <label>单只金额上限<input id="settingMaxSingleAmount" type="number" min="1000" step="500" value="${settings.maxSingleAmount}" required /><small>元</small></label>
            <label>单只仓位上限<input id="settingMaxPosition" type="number" min="5" max="100" step="1" value="${settings.maxPositionPercent}" required /><small>%</small></label>
            <label>单次计划损失<input id="settingMaxRisk" type="number" min="0.2" max="10" step="0.1" value="${settings.maxRiskPercent}" required /><small>%</small></label>
          </div>
          <div class="settings-group-heading"><div><h2>候选条件</h2><p>科创板保持排除；创业板可以单独开启</p></div></div>
          <div class="radar-settings-grid">
            <label>最低价格<input id="settingMinPrice" type="number" min="1" max="500" step="1" value="${settings.minPrice}" required /><small>元</small></label>
            <label>最高价格<input id="settingMaxPrice" type="number" min="1" max="500" step="1" value="${settings.maxPrice}" required /><small>元</small></label>
            <label>流通市值下限<input id="settingMinFloatCap" type="number" min="0" step="5" value="${settings.minFloatMarketCapYi}" required /><small>亿元</small></label>
            <label>流通市值上限<input id="settingMaxFloatCap" type="number" min="0" step="10" value="${settings.maxFloatMarketCapYi}" required /><small>亿元</small></label>
            <label>总市值上限<input id="settingMaxTotalCap" type="number" min="0" step="10" value="${settings.maxTotalMarketCapYi}" required /><small>亿元</small></label>
            <label>成交额下限<input id="settingMinAmount" type="number" min="0.5" max="100" step="0.5" value="${settings.minDailyAmountYi}" required /><small>亿元</small></label>
            <label>换手率下限<input id="settingMinTurnover" type="number" min="0" max="100" step="0.5" value="${settings.minTurnoverRate}" required /><small>%</small></label>
            <label>换手率上限<input id="settingMaxTurnover" type="number" min="0" max="100" step="0.5" value="${settings.maxTurnoverRate}" required /><small>%</small></label>
            <label>最少上市时间<input id="settingListedDays" type="number" min="30" max="2000" step="30" value="${settings.minListedDays}" required /><small>天</small></label>
            <label class="setting-toggle"><input id="settingChiNext" type="checkbox" ${settings.includeChiNext ? 'checked' : ''} /><span><strong>包含创业板</strong><small>价格波动范围更大，默认关闭</small></span></label>
          </div>
          <div class="radar-settings-actions"><button class="button" id="cancelRadarSettings" type="button">取消</button><button class="button primary" type="submit">保存并重新计算</button></div>
        </form>
      </section>`;
  }

  function stockAiAnalysisMarkup(ai) {
    if (appState.stockAiLoading) {
      return `<section class="stock-ai-panel stock-ai-state"><span class="spinner"></span><div><strong>AI 正在核对证据</strong><p>整理规则结论、量价、方向热度和相关资讯</p></div></section>`;
    }

    const agentStatus = appState.bootstrap?.aiAgent || {};
    const settings = appState.bootstrap?.radarSettings || appState.bootstrap?.latestRadar?.settings || defaultRadarSettings;
    const aiEnabled = settings.aiEnabled !== false;
    const status = aiEnabled ? (ai?.status || (agentStatus.enabled ? 'skipped' : 'not-configured')) : 'disabled';
    if (status !== 'ready') {
      const stateCopy = {
        disabled: ['AI 研判已关闭', '当前只显示固定规则分析；重新启用后可按需生成 AI 研判。'],
        'not-configured': ['AI 研判未启用', '本地服务尚未配置 AI 服务，固定规则分析不受影响。'],
        error: ['AI 研判未完成', ai?.message || '可以稍后重新生成，固定规则分析仍然有效。'],
        skipped: ['AI 研判需要更新', ai?.message || '固定规则已经更新，可以按需重新生成 AI 研判。']
      }[status] || ['AI 研判暂不可用', '固定规则分析仍然有效。'];
      return `
        <section class="stock-ai-panel stock-ai-state ${status === 'error' ? 'error' : ''}">
          <span class="stock-ai-mark">${icon('spark', 18)}</span>
          <div><strong>${escapeHtml(stateCopy[0])}</strong><p>${escapeHtml(stateCopy[1])}</p></div>
          ${aiEnabled && agentStatus.enabled && status !== 'not-configured' ? `<button class="button compact" id="retryStockAi" type="button">${icon('refresh', 14)}重新研判</button>` : ''}
        </section>`;
    }

    const result = ai.result;
    const verdictTone = result.verdict === '进入观察' ? 'watch' : result.verdict === '暂不考虑' ? 'exit' : 'wait';
    return `
      <section class="stock-ai-panel">
        <div class="stock-ai-heading">
          <div><span class="stock-ai-mark">${icon('spark', 18)}</span><div><h4>AI 研判</h4><p>${escapeHtml(ai.asOfDate)} 收盘证据 · ${escapeHtml(ai.model)}</p></div></div>
          <button class="button compact" id="retryStockAi" type="button">${icon('refresh', 14)}重新研判</button>
        </div>
        <div class="stock-ai-summary">
          <div>${radarActionMarkup(result.verdict, verdictTone)}<span>置信度 <strong>${formatNumber(result.confidence, 0)}</strong></span><span>与规则 ${escapeHtml(result.ruleAlignment)}</span></div>
          <p>${escapeHtml(result.summary)}</p>
        </div>
        <div class="stock-ai-signals">
          ${result.signals.map((item) => `<article class="${item.stance === '支持' ? 'support' : item.stance === '谨慎' ? 'caution' : 'neutral'}"><div><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.stance)}</span></div><p>${escapeHtml(item.detail)}</p><small>${item.evidenceIds.map(escapeHtml).join(' · ')}</small></article>`).join('')}
        </div>
        <div class="stock-ai-grid">
          <div><h5>下一步核对</h5><ul>${result.entryChecklist.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>
          <div><h5>停止观察</h5><ul>${result.stopChecklist.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>
          <div><h5>数据限制</h5><ul>${result.uncertainties.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>
        </div>
        <div class="stock-ai-news"><strong>资讯判断</strong><p>${escapeHtml(result.newsView)}</p></div>
      </section>`;
  }

  function stockAnalysisResultMarkup(analysis) {
    const funding = analysis.funding;
    const sectorPosition = analysis.sectorRank ? `第 ${analysis.sectorRank} 名` : '暂无排名';
    const fundingQuantity = funding.quantity >= 100 ? `${funding.quantity} 股` : '暂不安排';
    return `
      <div class="stock-analysis-result">
        <div class="stock-analysis-lead">
          <div class="stock-analysis-identity">
            <span>${escapeHtml(analysis.asOfDate)} · ${escapeHtml(analysis.session?.label || '收盘数据')}</span>
            <h3>${escapeHtml(analysis.name)} <small>${escapeHtml(analysis.code)}</small></h3>
            <div><strong>${formatNumber(analysis.price, 2)}</strong><span class="${analysis.changePercent >= 0 ? 'quote-up' : 'quote-down'}">${signedPercent(analysis.changePercent)}</span><span>${escapeHtml(analysis.sector)}</span></div>
          </div>
          <div class="stock-analysis-answer">
            ${radarActionMarkup(analysis.decision, analysis.decisionTone)}
            <p>${escapeHtml(analysis.summary)}</p>
          </div>
        </div>
        <div class="stock-analysis-facts">
          <div><span>方向热度</span><strong>${analysis.sectorHeat === null ? '—' : formatNumber(analysis.sectorHeat, 0)}</strong><small>${escapeHtml(sectorPosition)}</small></div>
          <div><span>市场温度</span><strong>${formatNumber(analysis.mood.score, 0)}</strong><small>${escapeHtml(analysis.mood.label)}</small></div>
          <div><span>换手率</span><strong>${formatNumber(analysis.turnoverRate, 1)}%</strong><small>量比 ${formatNumber(analysis.volumeRatio, 1)}</small></div>
          <div><span>阶段位置</span><strong class="${analysis.change60d >= 0 ? 'quote-up' : 'quote-down'}">${signedPercent(analysis.change60d)}</strong><small>${analysis.recentMetrics ? `近20日 ${signedPercent(analysis.recentMetrics.return20d)} · 距高 ${signedPercent(analysis.recentMetrics.distanceTo20High)}` : `今年以来 ${signedPercent(analysis.changeYear)}`}</small></div>
          <div><span>综合分</span><strong>${analysis.score === null ? '—' : formatNumber(analysis.score, 0)}</strong><small>${analysis.personalFit ? '风险门与个人条件均通过' : '暂未通过全部条件'}</small></div>
        </div>
        ${factorScoresMarkup(analysis.factorScores)}
        <div class="stock-analysis-body">
          <div class="stock-analysis-reasons">
            <h4>判断理由</h4>
            <ul>${analysis.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>
            ${analysis.issues.length ? `<div class="stock-analysis-issues"><strong>未通过条件</strong><span>${analysis.issues.map(escapeHtml).join('；')}</span></div>` : ''}
            ${analysis.riskFlags?.length ? `<div class="stock-analysis-issues"><strong>过热原因</strong><span>${analysis.riskFlags.map(escapeHtml).join('；')}</span></div>` : ''}
          </div>
          <div class="stock-analysis-plan">
            <h4>行动条件</h4>
            <p><strong>满足后再看</strong><span>${escapeHtml(analysis.entryCondition)}</span></p>
            <p class="candidate-stop"><strong>停止观察</strong><span>${escapeHtml(analysis.invalidation)}</span></p>
          </div>
        </div>
        <div class="stock-analysis-funding">
          <div><span>建议数量</span><strong>${fundingQuantity}</strong></div>
          <div><span>预计占用</span><strong>${formatMoney(funding.plannedAmount)}</strong></div>
          <div><span>账户占比</span><strong>${formatNumber(funding.positionPercent, 1)}%</strong></div>
          <div><span>计划最大损失</span><strong>${formatMoney(funding.plannedLoss)}</strong><small>${formatNumber(funding.riskPercent, 2)}% · 受${escapeHtml(funding.limitingFactor)}约束</small></div>
        </div>
        ${analysis.news.length ? `<div class="stock-analysis-news"><strong>相关方向资讯</strong>${analysis.news.slice(0, 2).map((item) => `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}<small>${escapeHtml(item.source)} · ${escapeHtml(item.publishedAt)}</small></a>`).join('')}</div>` : ''}
        ${stockAiAnalysisMarkup(appState.stockAiAnalysis)}
      </div>`;
  }

  function stockAnalysisMarkup() {
    return `
      <section class="page-band stock-analysis-panel">
        <div class="section-heading"><div><h2>单股分析</h2><p>输入名称或代码，判断当前阶段是否值得进入观察计划</p></div><span class="state-label">按当前资金方案</span></div>
        <form class="stock-analysis-search" id="stockAnalysisForm">
          <div>
            <label for="stockAnalysisSearch">证券名称或代码</label>
            <div class="instrument-search-wrap">
              <div class="instrument-search-control">${icon('search', 17)}<input id="stockAnalysisSearch" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="stockAnalysisSuggestions" autocomplete="off" placeholder="例如：平安银行或 000001" value="${escapeHtml(appState.stockAnalysisQuery)}" /></div>
              <input id="stockAnalysisCode" type="hidden" value="${escapeHtml(appState.stockAnalysisCode)}" />
              <div class="instrument-suggestions" id="stockAnalysisSuggestions" role="listbox" aria-label="证券搜索结果" hidden></div>
            </div>
          </div>
          <button class="button primary" type="submit" ${appState.stockAnalysisLoading ? 'disabled' : ''}>${appState.stockAnalysisLoading ? '<span class="spinner" style="width:16px;height:16px"></span>分析中' : `${icon('search', 16)}开始分析`}</button>
        </form>
        ${appState.stockAnalysisError ? `<div class="inline-alert">${icon('alert', 16)}<span>${escapeHtml(appState.stockAnalysisError)}</span></div>` : ''}
        ${appState.stockAnalysisLoading ? '<div class="stock-analysis-loading"><span class="spinner"></span><strong>正在整理最新收盘状态</strong></div>' : appState.stockAnalysis ? stockAnalysisResultMarkup(appState.stockAnalysis) : '<div class="stock-analysis-empty">选择一只证券后，这里会给出结论、理由、行动条件和建议数量。</div>'}
      </section>`;
  }

  function renderRadar(content) {
    const radar = appState.bootstrap.latestRadar;
    if (!radar && appState.radarLoading) {
      content.innerHTML = `<div class="loading-panel"><div class="spinner"></div><strong>正在读取全市场收盘数据</strong><span>整理市场温度、强势板块和短线候选</span></div>`;
      return;
    }
    if (!radar && appState.radarError) {
      content.innerHTML = `<div class="error-state">${icon('alert', 34)}<h2>短线雷达暂时没有结果</h2><p>${escapeHtml(appState.radarError)}</p><button class="button primary" id="retryRadar" type="button">${icon('refresh', 16)}重新更新</button></div>`;
      document.getElementById('retryRadar')?.addEventListener('click', refreshRadarData);
      return;
    }
    if (!radar) {
      appState.radarLoading = true;
      renderRadar(content);
      refreshRadarData();
      return;
    }

    const moodTone = radar.mood.score >= 72 ? 'hot' : radar.mood.score >= 55 ? 'warm' : radar.mood.score >= 40 ? 'mixed' : 'cold';
    const history = appState.bootstrap.radarHistory || [];
    const previousCandidateRecord = history.find((item) => item.asOfDate < radar.asOfDate && item.candidates?.length);
    const settings = appState.radarSettingsDraft || appState.bootstrap.radarSettings || radar.settings || defaultRadarSettings;
    const aiEnabled = settings.aiEnabled !== false;
    const sessionLabel = radar.session?.label || '收盘后计划';
    const overheatWatch = radar.overheatWatch || radar.boardWatch || [];
    content.innerHTML = `
      <div class="standard-page radar-page">
        <header class="radar-header">
          <div><span class="page-eyebrow">${escapeHtml(radar.asOfDate)} · ${escapeHtml(sessionLabel)}</span><h1>短线市场雷达</h1><p>先排除高位过热，再寻找未来 1 至 5 个交易日可能启动的观察对象。</p></div>
          <div class="page-actions"><span class="radar-source ${radar.stale ? 'stale' : ''}">${radar.stale ? (radar.fallbackReason ? `使用 ${escapeHtml(radar.asOfDate)} 有效数据` : '本地最近数据') : `更新于 ${formatDateTime(radar.generatedAt)}`}</span>${radarAiToggleMarkup(settings)}<button class="button primary" id="refreshRadar" type="button" ${appState.radarLoading || appState.radarAiToggleLoading ? 'disabled' : ''}>${appState.radarLoading ? '<span class="spinner" style="width:16px;height:16px"></span>更新中' : `${icon('refresh', 16)}更新雷达`}</button></div>
        </header>

        ${appState.radarError ? `<div class="inline-alert">${icon('alert', 16)}<span>${escapeHtml(appState.radarError)}，当前继续显示上次结果。</span></div>` : ''}
        ${radar.fallbackReason ? `<div class="inline-alert">${icon('database', 16)}<span>${escapeHtml(radar.fallbackReason)}。</span></div>` : ''}

        ${radarProfileMarkup(settings)}
        ${radarSettingsMarkup(settings)}
        ${stockAnalysisMarkup()}

        <section class="radar-overview ${moodTone}">
          <div class="mood-panel">
            <div class="mood-heading"><span>市场温度</span><strong>${escapeHtml(radar.mood.label)}</strong></div>
            <div class="mood-score"><strong>${radar.mood.score}</strong><span>/ 100</span></div>
            <div class="mood-track" aria-label="市场温度 ${radar.mood.score} 分"><span style="width:${Math.max(2, Math.min(100, radar.mood.score))}%"></span></div>
            <p>${escapeHtml(radar.mood.positionHint)}</p>
            <dl class="mood-stats"><div><dt>上涨</dt><dd>${radar.mood.advancers}</dd></div><div><dt>下跌</dt><dd>${radar.mood.decliners}</dd></div><div><dt>涨停附近</dt><dd>${radar.mood.limitUp}</dd></div><div><dt>成交额</dt><dd>${formatCompactAmount(radar.mood.amount)}</dd></div></dl>
          </div>
          <div class="sector-panel">
            <div class="section-heading"><div><h2>强势方向</h2><p>涨幅、宽度、活跃资金与资讯催化综合排序</p></div><span>${radar.scope.eligibleCount} 只符合个人条件</span></div>
            <div class="sector-list">${radar.sectors.slice(0, 6).map((sector) => `
              <div class="sector-row"><span class="sector-rank">${String(sector.rank).padStart(2, '0')}</span><strong>${escapeHtml(sector.name)}</strong><div class="sector-bar"><span style="width:${sector.heatScore}%"></span></div><span class="sector-change ${sector.avgChange >= 0 ? 'quote-up' : 'quote-down'}">${signedPercent(sector.avgChange)}</span><span class="sector-heat">${sector.heatScore}</span></div>`).join('')}</div>
          </div>
        </section>

        <section class="page-band radar-candidates">
          <div class="section-heading"><div><h2>下一波观察候选</h2><p>${radar.session?.type === 'intraday' ? '当前为盘中快照，只记录观察，等待收盘确认' : (aiEnabled ? '风险门先筛选，AI 再在合格池内比较' : '当前仅按多因子规则筛选和排序')}；本次最多 ${radar.selectionLimit || 3} 只</p></div><span class="state-label warning">条件计划</span></div>
          ${radarAiStatusMarkup(radar)}
          <div class="candidate-list">${radar.candidates.length ? radar.candidates.map(candidateMarkup).join('') : previousCandidatesMarkup(previousCandidateRecord)}</div>
        </section>

        <section class="radar-two-column">
          <div class="page-band board-panel"><div class="section-heading"><div><h2>过热回避</h2><p>这些股票热度较高，但不进入普通候选</p></div></div>${overheatWatch.length ? `<div class="board-list">${overheatWatch.map((item) => `<div class="board-row"><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.code)} · ${escapeHtml(item.sector)}</span></div><div class="board-quote"><strong class="quote-up">${signedPercent(item.changePercent)}</strong><span>换手 ${formatNumber(item.turnoverRate, 1)}%</span></div><p>${escapeHtml(item.note)}</p></div>`).join('')}</div>` : '<div class="radar-empty"><span>当前没有触发高位风险门的观察对象。</span></div>'}</div>
          <div class="page-band news-panel"><div class="section-heading"><div><h2>方向催化</h2><p>仅展示与强势板块相关的公开资讯</p></div></div>${radar.news.length ? `<div class="news-list">${radar.news.slice(0, 5).map((item) => `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer"><span>${escapeHtml(item.relatedSectors.join(' · '))}</span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.source)} · ${escapeHtml(item.publishedAt)}</small></a>`).join('')}</div>` : '<div class="radar-empty"><span>当前没有与强势方向明确相关的资讯，候选只按量价数据排序。</span></div>'}</div>
        </section>

        <section class="page-band holdings-panel">
          <div class="section-heading"><div><h2>我的持仓</h2><p>按你的成本和最新收盘状态给出条件式处理计划</p></div><button class="button" id="toggleHoldingForm" type="button">${icon('plus', 16)}添加持仓</button></div>
          ${holdingFormMarkup()}
          ${holdingRowsMarkup(radar.holdings || [])}
        </section>

        <section class="page-band tracking-panel">
          <div class="section-heading"><div><h2>候选追踪</h2><p>仅在新的市场日期刷新时推进观察周期</p></div></div>
          ${radarHistoryMarkup(history)}
        </section>

        <section class="radar-footnote"><strong>数据口径</strong><span>${radar.assumptions.map(escapeHtml).join('；')}。</span><span>已排除：${radar.scope.excluded.map(escapeHtml).join('、')}。</span></section>
      </div>`;
    bindRadarEvents();
  }

  function renderStockAnalysisSuggestions(items, status = '') {
    const container = document.getElementById('stockAnalysisSuggestions');
    const input = document.getElementById('stockAnalysisSearch');
    if (!container || !input) return;
    container.innerHTML = status
      ? `<div class="instrument-suggestion-status">${escapeHtml(status)}</div>`
      : items.length
        ? items.map((item) => `<button class="instrument-suggestion" type="button" role="option" data-analysis-code="${escapeHtml(item.id)}" data-analysis-name="${escapeHtml(item.name)}"><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.id)}</small></span><span class="instrument-market">${escapeHtml(item.market)}</span>${icon('chevron', 16)}</button>`).join('')
        : '<div class="instrument-suggestion-status">没有找到匹配证券</div>';
    container.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function bindStockAnalysis() {
    const form = document.getElementById('stockAnalysisForm');
    const input = document.getElementById('stockAnalysisSearch');
    const codeInput = document.getElementById('stockAnalysisCode');
    const suggestions = document.getElementById('stockAnalysisSuggestions');
    if (!form || !input || !codeInput || !suggestions) return;

    // 请求编号用于忽略较慢的旧搜索结果，保证名称联想始终对应当前输入。
    input.addEventListener('input', () => {
      appState.stockAnalysisQuery = input.value;
      appState.stockAnalysisCode = '';
      codeInput.value = '';
      window.clearTimeout(appState.stockAnalysisSearchTimer);
      const query = input.value.trim();
      if (!query) {
        suggestions.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        return;
      }
      const requestId = ++appState.stockAnalysisSearchRequestId;
      appState.stockAnalysisSearchTimer = window.setTimeout(async () => {
        renderStockAnalysisSuggestions([], '正在搜索');
        try {
          const payload = await api(`/api/instruments/search?q=${encodeURIComponent(query)}`);
          if (requestId !== appState.stockAnalysisSearchRequestId || input.value.trim() !== query) return;
          appState.stockAnalysisSuggestions = payload.instruments;
          renderStockAnalysisSuggestions(payload.instruments);
        } catch (error) {
          if (requestId === appState.stockAnalysisSearchRequestId) renderStockAnalysisSuggestions([], error.message);
        }
      }, 260);
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        suggestions.hidden = true;
        input.setAttribute('aria-expanded', 'false');
      }
      if (event.key === 'ArrowDown') {
        const first = suggestions.querySelector('.instrument-suggestion');
        if (first) {
          event.preventDefault();
          first.focus();
        }
      }
      if (event.key === 'Enter' && !codeInput.value) {
        const first = suggestions.querySelector('.instrument-suggestion');
        if (first) {
          event.preventDefault();
          first.click();
        }
      }
    });
    suggestions.addEventListener('mousedown', (event) => event.preventDefault());
    suggestions.addEventListener('click', (event) => {
      const button = event.target.closest('[data-analysis-code]');
      if (!button) return;
      appState.stockAnalysisCode = button.dataset.analysisCode;
      appState.stockAnalysisQuery = `${button.dataset.analysisName} ${button.dataset.analysisCode}`;
      codeInput.value = appState.stockAnalysisCode;
      input.value = appState.stockAnalysisQuery;
      suggestions.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    });
    input.addEventListener('blur', () => window.setTimeout(() => {
      suggestions.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    }, 140));
    form.addEventListener('submit', analyzeStockFromRadar);
    document.getElementById('retryStockAi')?.addEventListener('click', refreshStockAiFromRadar);
  }

  async function analyzeStockFromRadar(event) {
    event.preventDefault();
    const input = document.getElementById('stockAnalysisSearch');
    const explicitCode = document.getElementById('stockAnalysisCode').value;
    const matchedCode = input.value.trim().match(/\b\d{6}\b/)?.[0] || '';
    const code = explicitCode || matchedCode;
    if (!code) {
      showToast('请先从搜索结果中选择证券', 'error');
      return;
    }
    appState.stockAnalysisCode = code;
    appState.stockAnalysisQuery = input.value.trim();
    appState.stockAnalysisLoading = true;
    appState.stockAnalysisError = null;
    appState.stockAiAnalysis = null;
    renderRadar(document.getElementById('pageContent'));
    try {
      const payload = await api('/api/radar/analyze', { method: 'POST', body: JSON.stringify({ code, includeAi: true }) });
      appState.stockAnalysis = payload.analysis;
      appState.stockAiAnalysis = payload.ai;
      appState.stockAnalysisQuery = `${payload.analysis.name} ${payload.analysis.code}`;
    } catch (error) {
      appState.stockAnalysis = null;
      appState.stockAiAnalysis = null;
      appState.stockAnalysisError = error.message;
    } finally {
      appState.stockAnalysisLoading = false;
      if (appState.activePage === 'radar') renderRadar(document.getElementById('pageContent'));
    }
  }

  async function refreshStockAiFromRadar() {
    if (!appState.stockAnalysisCode || appState.stockAiLoading) return;
    appState.stockAiLoading = true;
    renderRadar(document.getElementById('pageContent'));
    try {
      const payload = await api('/api/radar/analyze', {
        method: 'POST',
        body: JSON.stringify({ code: appState.stockAnalysisCode, includeAi: true })
      });
      appState.stockAnalysis = payload.analysis;
      appState.stockAiAnalysis = payload.ai;
    } catch (error) {
      appState.stockAiAnalysis = { status: 'error', message: error.message };
    } finally {
      appState.stockAiLoading = false;
      if (appState.activePage === 'radar') renderRadar(document.getElementById('pageContent'));
    }
  }

  function renderHoldingSuggestions(items, status = '') {
    const container = document.getElementById('holdingSuggestions');
    const input = document.getElementById('holdingSearch');
    if (!container || !input) return;
    container.innerHTML = status
      ? `<div class="instrument-suggestion-status">${escapeHtml(status)}</div>`
      : items.length
        ? items.map((item) => `<button class="instrument-suggestion" type="button" role="option" data-holding-code="${escapeHtml(item.id)}" data-holding-name="${escapeHtml(item.name)}"><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.id)}</small></span><span class="instrument-market">${escapeHtml(item.market)}</span>${icon('plus', 16)}</button>`).join('')
        : '<div class="instrument-suggestion-status">没有找到匹配证券</div>';
    container.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function bindHoldingForm() {
    const form = document.getElementById('holdingForm');
    const searchInput = document.getElementById('holdingSearch');
    const codeInput = document.getElementById('holdingCode');
    const suggestions = document.getElementById('holdingSuggestions');
    if (!form || !searchInput || !codeInput || !suggestions) return;
    searchInput.addEventListener('input', () => {
      codeInput.value = '';
      window.clearTimeout(appState.holdingSearchTimer);
      const query = searchInput.value.trim();
      if (!query) {
        suggestions.hidden = true;
        return;
      }
      appState.holdingSearchTimer = window.setTimeout(async () => {
        renderHoldingSuggestions([], '正在搜索');
        try {
          const payload = await api(`/api/instruments/search?q=${encodeURIComponent(query)}`);
          if (searchInput.value.trim() !== query) return;
          appState.holdingSuggestions = payload.instruments;
          renderHoldingSuggestions(payload.instruments);
        } catch (error) {
          renderHoldingSuggestions([], error.message);
        }
      }, 260);
    });
    suggestions.addEventListener('mousedown', (event) => event.preventDefault());
    suggestions.addEventListener('click', (event) => {
      const button = event.target.closest('[data-holding-code]');
      if (!button) return;
      codeInput.value = button.dataset.holdingCode;
      searchInput.value = `${button.dataset.holdingName} ${button.dataset.holdingCode}`;
      suggestions.hidden = true;
      searchInput.setAttribute('aria-expanded', 'false');
    });
    searchInput.addEventListener('blur', () => window.setTimeout(() => { suggestions.hidden = true; }, 140));
    form.addEventListener('submit', saveHoldingFromRadar);
  }

  function bindRadarEvents() {
    document.getElementById('refreshRadar')?.addEventListener('click', refreshRadarData);
    document.getElementById('toggleRadarAi')?.addEventListener('click', toggleRadarAi);
    bindStockAnalysis();
    document.getElementById('toggleRadarSettings')?.addEventListener('click', () => {
      appState.radarSettingsDraft = clone(appState.bootstrap.radarSettings || appState.bootstrap.latestRadar?.settings || defaultRadarSettings);
      appState.radarSettingsOpen = true;
      renderRadar(document.getElementById('pageContent'));
      document.getElementById('settingCapital')?.focus();
    });
    document.getElementById('cancelRadarSettings')?.addEventListener('click', () => {
      appState.radarSettingsOpen = false;
      appState.radarSettingsDraft = null;
      renderRadar(document.getElementById('pageContent'));
    });
    document.getElementById('radarSettingsForm')?.addEventListener('submit', saveRadarSettingsFromPage);
    document.getElementById('toggleHoldingForm')?.addEventListener('click', () => {
      appState.holdingFormOpen = true;
      renderRadar(document.getElementById('pageContent'));
      document.getElementById('holdingSearch')?.focus();
    });
    document.getElementById('cancelHolding')?.addEventListener('click', () => {
      appState.holdingFormOpen = false;
      renderRadar(document.getElementById('pageContent'));
    });
    document.querySelectorAll('[data-remove-holding]').forEach((button) => {
      button.addEventListener('click', () => removeHoldingFromRadar(button.dataset.removeHolding));
    });
    bindHoldingForm();
  }

  async function toggleRadarAi() {
    if (appState.radarAiToggleLoading || appState.radarLoading) return;
    const settings = appState.bootstrap.radarSettings || appState.bootstrap.latestRadar?.settings || defaultRadarSettings;
    const enabled = settings.aiEnabled === false;
    appState.radarAiToggleLoading = true;
    appState.radarAiToggleTarget = enabled;
    appState.radarError = null;
    renderRadar(document.getElementById('pageContent'));
    try {
      const payload = await api('/api/radar/ai-toggle', {
        method: 'POST',
        body: JSON.stringify({ enabled })
      });
      appState.bootstrap.radarSettings = payload.settings;
      appState.bootstrap.latestRadar = payload.radar;
      appState.bootstrap.radarHistory = payload.history;
      if (appState.radarSettingsDraft) appState.radarSettingsDraft.aiEnabled = enabled;
      if (appState.stockAnalysis) {
        appState.stockAiAnalysis = enabled
          ? { status: 'skipped', message: 'AI 研判已启用，可重新研判当前证券' }
          : { status: 'disabled', message: 'AI 研判已关闭，当前只显示固定规则分析' };
      }
      showToast(enabled ? 'AI 研判已启用' : 'AI 研判已关闭');
    } catch (error) {
      appState.radarError = error.message;
      showToast(error.message, 'error');
    } finally {
      appState.radarAiToggleLoading = false;
      appState.radarAiToggleTarget = null;
      if (appState.activePage === 'radar') renderRadar(document.getElementById('pageContent'));
    }
  }

  async function refreshRadarData() {
    if (appState.radarLoading || appState.radarAiToggleLoading) return;
    appState.radarLoading = true;
    appState.radarError = null;
    if (appState.activePage === 'radar') renderRadar(document.getElementById('pageContent'));
    try {
      const payload = await api('/api/radar/refresh', { method: 'POST', body: '{}' });
      appState.bootstrap.latestRadar = payload.radar;
      appState.bootstrap.radarHistory = payload.history;
      if (payload.radar.settings) appState.bootstrap.radarSettings = payload.radar.settings;
      refreshTopbarDataContext();
      if (appState.stockAnalysisCode) {
        try {
          const analysisPayload = await api('/api/radar/analyze', { method: 'POST', body: JSON.stringify({ code: appState.stockAnalysisCode, includeAi: false }) });
          appState.stockAnalysis = analysisPayload.analysis;
          appState.stockAiAnalysis = analysisPayload.ai;
          appState.stockAnalysisError = null;
        } catch (error) {
          appState.stockAnalysis = null;
          appState.stockAiAnalysis = null;
          appState.stockAnalysisError = error.message;
        }
      }
    } catch (error) {
      appState.radarError = error.message;
    } finally {
      appState.radarLoading = false;
      if (appState.activePage === 'radar') renderRadar(document.getElementById('pageContent'));
    }
  }

  async function saveRadarSettingsFromPage(event) {
    event.preventDefault();
    const value = (id) => Number(document.getElementById(id).value);
    const settings = {
      capital: value('settingCapital'),
      cashReservePercent: value('settingCashReserve'),
      maxPositions: value('settingMaxPositions'),
      maxSingleAmount: value('settingMaxSingleAmount'),
      maxPositionPercent: value('settingMaxPosition'),
      maxRiskPercent: value('settingMaxRisk'),
      minPrice: value('settingMinPrice'),
      maxPrice: value('settingMaxPrice'),
      minFloatMarketCapYi: value('settingMinFloatCap'),
      maxFloatMarketCapYi: value('settingMaxFloatCap'),
      maxTotalMarketCapYi: value('settingMaxTotalCap'),
      minDailyAmountYi: value('settingMinAmount'),
      minTurnoverRate: value('settingMinTurnover'),
      maxTurnoverRate: value('settingMaxTurnover'),
      minListedDays: value('settingListedDays'),
      includeChiNext: document.getElementById('settingChiNext').checked,
      aiEnabled: (appState.bootstrap.radarSettings || appState.bootstrap.latestRadar?.settings || defaultRadarSettings).aiEnabled !== false
    };
    const submitButton = event.submitter;
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.innerHTML = '<span class="spinner" style="width:16px;height:16px"></span>正在保存';
    }
    try {
      const payload = await api('/api/radar/settings', { method: 'POST', body: JSON.stringify(settings) });
      appState.bootstrap.radarSettings = payload.settings;
      appState.radarSettingsDraft = null;
      appState.radarSettingsOpen = false;
      await refreshRadarData();
      showToast('资金方案与筛选条件已更新');
    } catch (error) {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = '保存并重新计算';
      }
      showToast(error.message, 'error');
    }
  }

  async function saveHoldingFromRadar(event) {
    event.preventDefault();
    const searchValue = document.getElementById('holdingSearch').value.trim();
    const explicitCode = document.getElementById('holdingCode').value;
    const code = explicitCode || (/^\d{6}$/.test(searchValue) ? searchValue : '');
    const selected = appState.holdingSuggestions.find((item) => item.id === code);
    if (!code) {
      showToast('请先从搜索结果中选择证券', 'error');
      return;
    }
    try {
      await api('/api/holdings', {
        method: 'POST',
        body: JSON.stringify({
          code,
          name: selected?.name || searchValue.replace(code, '').trim() || code,
          quantity: Number(document.getElementById('holdingQuantity').value),
          cost: Number(document.getElementById('holdingCost').value)
        })
      });
      appState.holdingFormOpen = false;
      const bootstrap = await api('/api/bootstrap');
      appState.bootstrap.holdings = bootstrap.holdings;
      await refreshRadarData();
      showToast('持仓已保存');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function removeHoldingFromRadar(holdingId) {
    try {
      await api(`/api/holdings/${encodeURIComponent(holdingId)}`, { method: 'DELETE' });
      const bootstrap = await api('/api/bootstrap');
      appState.bootstrap.holdings = bootstrap.holdings;
      await refreshRadarData();
      showToast('持仓已移除');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  function signalStatusLabel(status, mode) {
    if (status === 'retain') return '继续保持';
    if (status === 'add') return mode === 'official' ? '新入选' : '拟加入';
    if (status === 'remove') return mode === 'official' ? '移出' : '拟移出';
    return '候补';
  }

  function signalReason(item, signal) {
    const targetCount = Number(appState.ruleDraft.topCount);
    if (item.status === 'retain') return `仍在目标前 ${targetCount} 名`;
    if (item.status === 'add') return `最新排名进入目标前 ${targetCount} 名`;
    if (item.status === 'remove') return item.rank
      ? `最新排名第 ${item.rank}，离开目标范围`
      : '当前未满足流动性或数据完整性条件';
    return `当前第 ${item.rank} 名，距目标线 ${Math.max(1, item.rank - targetCount)} 位`;
  }

  function rankChangeMarkup(value) {
    if (value === null || value === undefined) return '<span class="rank-change new">新</span>';
    if (value > 0) return `<span class="rank-change up">↑ ${value}</span>`;
    if (value < 0) return `<span class="rank-change down">↓ ${Math.abs(value)}</span>`;
    return '<span class="rank-change">—</span>';
  }

  function signalTable(rows, signal, emptyText) {
    if (!rows.length) return `<div class="signal-empty">${escapeHtml(emptyText)}</div>`;
    const value = (input, formatter) => input === null || input === undefined ? '—' : formatter(input);
    return `<div class="data-table-wrap"><table class="data-table signal-table"><thead><tr><th>状态</th><th class="number">排名</th><th>证券</th><th class="number">排名变化</th><th class="number">综合分</th><th class="number">趋势</th><th class="number">年化波动</th><th class="number">日均成交额</th><th class="number">最新收盘</th></tr></thead><tbody>${rows.map((item) => `<tr><td><span class="signal-status ${item.status}">${signalStatusLabel(item.status, signal.mode)}</span></td><td class="number">${item.rank || '—'}</td><td><strong>${escapeHtml(item.name)}</strong> <span class="security-code">${escapeHtml(item.assetId)}</span><small class="signal-reason">${escapeHtml(signalReason(item, signal))}</small></td><td class="number">${rankChangeMarkup(item.rankChange)}</td><td class="number">${value(item.score, (number) => formatNumber(number * 100, 1))}</td><td class="number">${value(item.trend, (number) => formatPercent(number))}</td><td class="number">${value(item.volatility, (number) => formatPercent(number))}</td><td class="number">${value(item.averageAmount, (number) => `${formatNumber(number, 0)} 百万`)}</td><td class="number">${value(item.close, (number) => formatNumber(number, 2))}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function renderSignals(content) {
    const rulesKey = JSON.stringify(appState.ruleDraft);
    if (appState.latestSignal && (appState.signalRulesKey !== rulesKey || appState.latestSignal.datasetId !== appState.bootstrap.dataset.id)) {
      appState.latestSignal = null;
    }
    if (appState.signalLoading || !appState.latestSignal && !appState.signalError) {
      content.innerHTML = `<div class="loading-panel"><div class="spinner"></div><strong>正在计算最新排名</strong><span>对照上次正式信号并整理变化原因</span></div>`;
      if (!appState.signalLoading) loadLatestSignal();
      return;
    }
    if (appState.signalError) {
      content.innerHTML = `<div class="error-state">${icon('alert', 34)}<h2>暂时无法生成每日信号</h2><p>${escapeHtml(appState.signalError)}</p><button class="button" id="retrySignal" type="button">${icon('refresh', 16)}重新计算</button></div>`;
      document.getElementById('retrySignal')?.addEventListener('click', () => {
        appState.signalError = null;
        renderSignals(content);
      });
      return;
    }

    const signal = appState.latestSignal;
    const modeLabel = signal.mode === 'official' ? '正式信号' : '观察预览';
    const changeRows = [...signal.removedRows, ...signal.watchRows];
    content.innerHTML = `
      <div class="standard-page signal-page">
        <header><div><h1>每日信号</h1><p>${escapeHtml(appState.strategyName)} · 使用当前规则计算</p></div><div class="page-actions"><button class="button" id="goSignalData" type="button">${icon('database', 16)}更新行情</button><button class="button primary" id="refreshSignal" type="button">${icon('refresh', 16)}重新计算</button></div></header>
        <section class="signal-banner ${signal.mode}">
          <div class="signal-mode-mark">${icon('signal', 22)}</div>
          <div><span class="page-eyebrow">${escapeHtml(signal.asOfDate)} 收盘后</span><h2>${modeLabel}</h2><p>${signal.mode === 'official' ? '当前周期已经结束，本次名单形成正式调整安排。' : `当前未到${escapeHtml(signal.frequencyText)}调整日，名单变化仅用于观察。`}</p></div>
          <span class="state-label ${signal.mode === 'official' ? 'success' : 'warning'}">${modeLabel}</span>
        </section>
        <section class="page-band"><div class="facts-grid signal-facts"><div class="fact"><span>数据日期</span><strong>${escapeHtml(signal.asOfDate)}</strong><small>${escapeHtml(appState.bootstrap.dataset.source)}</small></div><div class="fact"><span>上次正式信号</span><strong>${escapeHtml(signal.referenceDate || '暂无')}</strong><small>${escapeHtml(signal.frequencyText)}调整</small></div><div class="fact"><span>有效候选</span><strong>${signal.candidateCount} 只</strong><small>目标 ${appState.ruleDraft.topCount} 只</small></div><div class="fact"><span>下一步</span><strong class="fact-text">${escapeHtml(signal.nextAction)}</strong><small>规则不变时</small></div></div></section>
        <section class="page-band"><div class="section-heading"><div><h2>当前目标名单</h2><p>按最新综合分排序；可用候选不足时不强行补足</p></div><span class="state-label success">${signal.selectedRows.length} 只</span></div>${signalTable(signal.selectedRows, signal, '当前没有满足条件的证券')}</section>
        <section class="page-band"><div class="section-heading"><div><h2>变化与候补</h2><p>与 ${escapeHtml(signal.referenceDate || '上次')} 正式信号对照</p></div><div class="signal-counts"><span>保持 ${signal.summary.retainCount}</span><span>变化 ${signal.summary.addCount + signal.summary.removeCount}</span><span>候补 ${signal.summary.watchCount}</span></div></div>${signalTable(changeRows, signal, '当前没有移出或候补项目')}</section>
        <section class="page-band signal-method"><div><h2>计算口径</h2><p>趋势 ${appState.ruleDraft.weights.trend}% · 稳定性 ${appState.ruleDraft.weights.stability}% · 流动性 ${appState.ruleDraft.weights.liquidity}% · 趋势观察 ${appState.ruleDraft.trendWindow} 个交易日</p></div><p class="data-note">${signal.assumptions.map(escapeHtml).join('；')}。名单是规则输出，不代表对当前价格的确定性判断。</p></section>
      </div>`;
    document.getElementById('refreshSignal')?.addEventListener('click', () => {
      appState.latestSignal = null;
      appState.signalError = null;
      renderSignals(content);
    });
    document.getElementById('goSignalData')?.addEventListener('click', () => {
      appState.activePage = 'data';
      renderShell();
    });
  }

  async function loadLatestSignal() {
    appState.signalLoading = true;
    appState.signalError = null;
    const rulesKey = JSON.stringify(appState.ruleDraft);
    try {
      const payload = await api('/api/signals/latest', {
        method: 'POST',
        body: JSON.stringify({ rules: appState.ruleDraft })
      });
      appState.latestSignal = payload.signal;
      appState.signalRulesKey = rulesKey;
      refreshTopbarDataContext();
    } catch (error) {
      appState.signalError = error.message;
    } finally {
      appState.signalLoading = false;
      if (appState.activePage === 'signals') renderSignals(document.getElementById('pageContent'));
    }
  }

  function renderJobs(content) {
    const jobs = appState.bootstrap.jobs;
    content.innerHTML = `<div class="standard-page"><header><div><h1>回测任务</h1><p>本机最近完成的计算记录</p></div><button class="button" id="refreshJobs" type="button">${icon('refresh', 16)}刷新</button></header><section class="page-band">${jobs.length ? `<div class="data-table-wrap"><table class="data-table"><thead><tr><th>状态</th><th>策略版本</th><th>完成时间</th><th class="number">耗时</th><th>结果编号</th></tr></thead><tbody>${jobs.map((job) => `<tr><td><span class="state-label success">已完成</span></td><td>${escapeHtml(job.versionId || '当前草案')}</td><td>${formatDateTime(job.completedAt)}</td><td class="number">${job.durationMs} ms</td><td>${escapeHtml(job.resultId.slice(0, 8))}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty-state">${icon('clock', 34)}<h2>还没有任务</h2><p>从策略工作台运行第一次回测后，任务记录会出现在这里。</p><button class="button primary" id="goStrategy" type="button">打开策略工作台</button></div>`}</section></div>`;
    document.getElementById('refreshJobs')?.addEventListener('click', reloadBootstrap);
    document.getElementById('goStrategy')?.addEventListener('click', () => { appState.activePage = 'strategy'; renderShell(); });
  }

  function marketSelectionMarkup() {
    if (!appState.marketSelection.length) {
      return '<span class="instrument-empty">还未选择证券</span>';
    }
    return appState.marketSelection.map((item) => `
      <span class="instrument-chip">
        <span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.id)} · ${escapeHtml(item.market || '待更新')}</small></span>
        <button type="button" data-remove-instrument="${escapeHtml(item.id)}" aria-label="移除 ${escapeHtml(item.name)}">${icon('close', 14)}</button>
      </span>`).join('');
  }

  function getMarketCodes() {
    const input = document.getElementById('marketCodes');
    const raw = input ? input.value : appState.marketSelection.map((item) => item.id).join(',');
    return [...new Set(raw.split(/[，,\s]+/).map((item) => item.trim()).filter(Boolean))];
  }

  function renderMarketSelection() {
    const container = document.getElementById('selectedInstruments');
    const counter = document.getElementById('instrumentCount');
    const codeInput = document.getElementById('marketCodes');
    if (container) container.innerHTML = marketSelectionMarkup();
    if (counter) counter.textContent = `${appState.marketSelection.length}/40`;
    if (codeInput) codeInput.value = appState.marketSelection.map((item) => item.id).join(', ');
  }

  function hideInstrumentSuggestions() {
    const container = document.getElementById('instrumentSuggestions');
    const input = document.getElementById('instrumentSearch');
    if (container) container.hidden = true;
    if (input) input.setAttribute('aria-expanded', 'false');
  }

  function renderInstrumentSuggestions(items, status = '') {
    const container = document.getElementById('instrumentSuggestions');
    const input = document.getElementById('instrumentSearch');
    if (!container || !input) return;
    const selectedCodes = new Set(appState.marketSelection.map((item) => item.id));
    const available = items.filter((item) => !selectedCodes.has(item.id));
    container.innerHTML = status
      ? `<div class="instrument-suggestion-status">${escapeHtml(status)}</div>`
      : available.length
        ? available.map((item) => `
          <button class="instrument-suggestion" type="button" role="option" data-add-instrument="${escapeHtml(item.id)}">
            <span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.id)}</small></span>
            <span class="instrument-market">${escapeHtml(item.market)}</span>
            ${icon('plus', 16)}
          </button>`).join('')
        : '<div class="instrument-suggestion-status">没有更多可添加的结果</div>';
    container.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function addMarketInstrument(item) {
    if (appState.marketSelection.some((candidate) => candidate.id === item.id)) return;
    if (appState.marketSelection.length >= 40) {
      showToast('证券范围最多 40 只', 'error');
      return;
    }
    appState.marketSelection.push(item);
    renderMarketSelection();
    const input = document.getElementById('instrumentSearch');
    if (input) {
      input.value = '';
      input.focus();
    }
    hideInstrumentSuggestions();
  }

  function bindInstrumentPicker() {
    const searchInput = document.getElementById('instrumentSearch');
    const suggestions = document.getElementById('instrumentSuggestions');
    const selection = document.getElementById('selectedInstruments');
    const codeInput = document.getElementById('marketCodes');
    if (!searchInput || !suggestions || !selection || !codeInput) return;

    // 请求编号用于丢弃慢请求的旧结果，避免快速输入时列表回跳。
    searchInput.addEventListener('input', () => {
      window.clearTimeout(appState.instrumentSearchTimer);
      const query = searchInput.value.trim();
      if (!query) {
        hideInstrumentSuggestions();
        return;
      }
      appState.instrumentSearchTimer = window.setTimeout(async () => {
        const requestId = ++appState.instrumentSearchRequestId;
        renderInstrumentSuggestions([], '正在搜索');
        try {
          const payload = await api(`/api/instruments/search?q=${encodeURIComponent(query)}`);
          if (requestId !== appState.instrumentSearchRequestId || searchInput.value.trim() !== query) return;
          appState.instrumentSuggestions = payload.instruments;
          renderInstrumentSuggestions(payload.instruments, payload.instruments.length ? '' : '没有找到匹配证券');
        } catch (error) {
          if (requestId !== appState.instrumentSearchRequestId) return;
          renderInstrumentSuggestions([], error.message);
        }
      }, 260);
    });

    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') hideInstrumentSuggestions();
      if (event.key === 'ArrowDown') {
        const first = suggestions.querySelector('.instrument-suggestion');
        if (first) {
          event.preventDefault();
          first.focus();
        }
      }
      if (event.key === 'Enter') {
        const first = suggestions.querySelector('.instrument-suggestion');
        if (first) {
          event.preventDefault();
          first.click();
        }
      }
    });

    searchInput.addEventListener('blur', () => window.setTimeout(hideInstrumentSuggestions, 140));
    suggestions.addEventListener('mousedown', (event) => event.preventDefault());
    suggestions.addEventListener('click', (event) => {
      const button = event.target.closest('[data-add-instrument]');
      if (!button) return;
      const item = appState.instrumentSuggestions.find((candidate) => candidate.id === button.dataset.addInstrument);
      if (item) addMarketInstrument(item);
    });

    selection.addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove-instrument]');
      if (!button) return;
      appState.marketSelection = appState.marketSelection.filter((item) => item.id !== button.dataset.removeInstrument);
      renderMarketSelection();
    });

    codeInput.addEventListener('change', () => {
      const known = new Map(appState.marketSelection.map((item) => [item.id, item]));
      appState.marketSelection = getMarketCodes()
        .filter((code) => /^\d{6}$/.test(code))
        .slice(0, 40)
        .map((code) => known.get(code) || { id: code, name: code, market: '待更新' });
      renderMarketSelection();
    });
  }

  function renderData(content) {
    const dataset = appState.bootstrap.dataset;
    const isReal = dataset.kind === 'real';
    content.innerHTML = `
      <div class="standard-page">
        <header><div><h1>数据状态</h1><p>${isReal ? '真实日行情已经保存到本机，可按代码范围重新更新' : '当前使用可重复生成的模拟日频数据'}</p></div><span class="state-label success">可用</span></header>
        <section class="page-band"><div class="facts-grid"><div class="fact"><span>数据版本</span><strong>${escapeHtml(dataset.id)}</strong><small>${isReal ? escapeHtml(dataset.source) : '固定生成规则'}</small></div><div class="fact"><span>证券数量</span><strong>${dataset.instrumentCount}</strong><small>${isReal ? '真实证券' : '全部为样例编号'}</small></div><div class="fact"><span>数据范围</span><strong>${escapeHtml(dataset.startDate.slice(0, 4))}—${escapeHtml(dataset.endDate.slice(0, 4))}</strong><small>${escapeHtml(dataset.priceMode || '模拟日频')}</small></div><div class="fact"><span>最近日期</span><strong>${escapeHtml(dataset.endDate)}</strong><small>${dataset.fetchedAt ? `更新于 ${formatDateTime(dataset.fetchedAt)}` : '本地生成'}</small></div></div></section>
        ${isReal ? `<section class="page-band"><div class="section-heading"><div><h2>真实证券范围</h2><p>按名称或代码添加，当前最多 40 只</p></div><button class="button" id="syncMarketData" type="button">${icon('refresh', 16)}更新真实数据</button></div><div class="instrument-picker"><div class="instrument-search-wrap"><div class="instrument-search-control">${icon('search', 17)}<input id="instrumentSearch" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="instrumentSuggestions" autocomplete="off" placeholder="搜索名称、代码或拼音首字母" /><span id="instrumentCount">${appState.marketSelection.length}/40</span></div><div class="instrument-suggestions" id="instrumentSuggestions" role="listbox" aria-label="证券搜索结果" hidden></div></div><div class="selected-instruments" id="selectedInstruments">${marketSelectionMarkup()}</div></div><details class="manual-codes"><summary>${icon('file', 15)}批量代码</summary><textarea id="marketCodes" aria-label="证券代码范围">${escapeHtml(appState.marketSelection.map((item) => item.id).join(', '))}</textarea></details></section>` : ''}
        <section class="page-band"><div class="section-heading"><div><h2>数据检查</h2><p>${isReal ? '缓存载入时统一日期并处理无成交日期' : '当前数据在每次运行时按相同规则生成'}</p></div></div><div class="quality-list"><div class="quality-item"><span>日期顺序</span><span>通过</span></div><div class="quality-item"><span>价格大于零</span><span>通过</span></div><div class="quality-item"><span>证券编号唯一</span><span>通过</span></div><div class="quality-item"><span>重复运行一致</span><span>通过</span></div></div></section>
        <section class="page-band"><p class="data-note">${escapeHtml(dataset.note)}</p></section>
      </div>`;
    document.getElementById('syncMarketData')?.addEventListener('click', syncMarketDataFromPage);
    if (isReal) bindInstrumentPicker();
  }

  function renderSettings(content) {
    const rules = appState.ruleDraft;
    content.innerHTML = `
      <div class="standard-page">
        <header><div><h1>本地设置</h1><p>当前版本不连接成员、套餐或付款能力</p></div><span class="state-label">只保存在本机</span></header>
        <section class="page-band"><div class="section-heading"><div><h2>默认研究设置</h2><p>策略版本会保存实际使用值</p></div></div><div class="field-grid four"><div class="field"><label>初始资金</label><input value="1,000,000 元" disabled /></div><div class="field"><label>年化无风险收益</label><input value="2%" disabled /></div><div class="field"><label>默认佣金</label><input value="${rules.commissionBps} 万分之一" disabled /></div><div class="field"><label>默认滑点</label><input value="${rules.slippageBps} 万分之一" disabled /></div></div></section>
        <section class="page-band"><div class="section-heading"><div><h2>模型设置</h2><p>研究诊断进入第二阶段后开放</p></div></div><div class="empty-state" style="min-height:180px">${icon('spark', 26)}<p>当前版本只使用本地规则解析，不会向外部模型发送策略内容。</p></div></section>
      </div>`;
  }

  function bindWorkspaceEvents() {
    document.querySelectorAll('[data-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        appState.activeTab = button.dataset.tab;
        renderWorkspace(document.getElementById('pageContent'));
      });
    });

    document.querySelectorAll('[data-rule]').forEach((input) => {
      input.addEventListener('input', () => {
        const key = input.dataset.rule;
        appState.ruleDraft[key] = input.type === 'number' ? Number(input.value) : input.value;
        appState.dirty = true;
        refreshContextAndHeader();
      });
    });

    document.querySelectorAll('[data-weight]').forEach((input) => {
      input.addEventListener('input', () => {
        const key = input.dataset.weight;
        appState.ruleDraft.weights[key] = Number(input.value);
        appState.dirty = true;
        const bar = document.getElementById(`bar-${key}`);
        if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(input.value)))}%`;
        refreshContextAndHeader();
      });
    });

    document.getElementById('ideaInput')?.addEventListener('input', (event) => {
      appState.idea = event.target.value;
    });
    document.getElementById('applyIdea')?.addEventListener('click', applyIdea);
    document.getElementById('saveVersion')?.addEventListener('click', () => persistVersion(false));
    document.getElementById('runBacktest')?.addEventListener('click', runBacktest);
    document.getElementById('emptyRun')?.addEventListener('click', runBacktest);
    document.querySelectorAll('.version-load').forEach((button) => {
      button.addEventListener('click', () => loadVersion(button.dataset.versionId));
    });
    if (appState.activeTab === 'results' && appState.bootstrap.latestResult) {
      bindResultEvents(appState.bootstrap.latestResult);
    }
  }

  function bindResultEvents(result) {
    document.querySelectorAll('[data-export]').forEach((button) => {
      button.addEventListener('click', () => exportResultCsv(button.dataset.export, result));
    });
    document.getElementById('exportTrades')?.addEventListener('click', () => exportResultCsv('trades', result));
    document.querySelectorAll('[data-evidence-target]').forEach((button) => {
      button.addEventListener('click', () => {
        const target = document.getElementById(button.dataset.evidenceTarget);
        if (!target) return;
        document.querySelector('.evidence-highlight')?.classList.remove('evidence-highlight');
        target.classList.add('evidence-highlight');
        const top = target.getBoundingClientRect().top + window.scrollY - 20;
        window.scrollTo({ top, behavior: 'smooth' });
        window.setTimeout(() => target.classList.remove('evidence-highlight'), 1800);
      });
    });

    const refreshTrades = () => {
      const items = filteredTrades(result);
      const host = document.querySelector('.trade-table-host');
      const count = document.getElementById('tradeCount');
      if (host) host.innerHTML = tradeTableHostTemplate(items);
      if (count) count.textContent = `${items.length} / ${result.summary.tradeCount} 笔`;
      bindTradeSortEvents(result, refreshTrades);
    };

    document.getElementById('tradeQuery')?.addEventListener('input', (event) => {
      appState.resultFilters.tradeQuery = event.target.value;
      appState.resultFilters.tradePage = 1;
      refreshTrades();
    });
    document.getElementById('tradeSide')?.addEventListener('change', (event) => {
      appState.resultFilters.tradeSide = event.target.value;
      appState.resultFilters.tradePage = 1;
      refreshTrades();
    });
    document.getElementById('tradeFrom')?.addEventListener('change', (event) => {
      appState.resultFilters.tradeFrom = event.target.value;
      appState.resultFilters.tradePage = 1;
      refreshTrades();
    });
    document.getElementById('tradeTo')?.addEventListener('change', (event) => {
      appState.resultFilters.tradeTo = event.target.value;
      appState.resultFilters.tradePage = 1;
      refreshTrades();
    });
    document.getElementById('clearTradeFilters')?.addEventListener('click', () => {
      appState.resultFilters.tradeQuery = '';
      appState.resultFilters.tradeSide = 'all';
      appState.resultFilters.tradeFrom = '';
      appState.resultFilters.tradeTo = '';
      appState.resultFilters.tradePage = 1;
      document.getElementById('tradeQuery').value = '';
      document.getElementById('tradeSide').value = 'all';
      document.getElementById('tradeFrom').value = '';
      document.getElementById('tradeTo').value = '';
      refreshTrades();
    });
    bindTradeSortEvents(result, refreshTrades);
  }

  function bindTradeSortEvents(result, refreshTrades) {
    document.querySelectorAll('[data-trade-sort]').forEach((button) => {
      button.addEventListener('click', () => {
        const key = button.dataset.tradeSort;
        if (appState.resultFilters.tradeSortKey === key) {
          appState.resultFilters.tradeSortDirection = appState.resultFilters.tradeSortDirection === 'asc' ? 'desc' : 'asc';
        } else {
          appState.resultFilters.tradeSortKey = key;
          appState.resultFilters.tradeSortDirection = key === 'name' ? 'asc' : 'desc';
        }
        appState.resultFilters.tradePage = 1;
        refreshTrades(result);
      });
    });
    document.querySelectorAll('[data-trade-page]').forEach((button) => {
      button.addEventListener('click', () => {
        appState.resultFilters.tradePage = Number(button.dataset.tradePage);
        refreshTrades(result);
      });
    });
  }

  function csvCell(value) {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function downloadCsv(filename, result, headers, rows) {
    const metadata = [
      ['结果编号', result.id],
      ['导出时间', new Date().toISOString()],
      ['字段说明', 'docs/03-backtest-metrics.md'],
      []
    ];
    const content = [...metadata, headers, ...rows]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n');
    const link = document.createElement('a');
    const fileUrl = URL.createObjectURL(new Blob(['\uFEFF', content], { type: 'text/csv;charset=utf-8' }));
    link.href = fileUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(fileUrl), 0);
  }

  function exportResultCsv(type, result) {
    const analysis = result.analysis || {};
    const shortId = String(result.id).slice(0, 8);
    if (type === 'annual') {
      downloadCsv(`年度收益-${shortId}.csv`, result,
        ['年度', '开始日期', '结束日期', '完整年度', '策略收益', '基准收益', '差值'],
        (analysis.annualReturns || []).map((item) => [item.year, item.startDate, item.endDate, item.complete ? '是' : '否', item.strategyReturn, item.benchmarkReturn, item.excessReturn]));
    }
    if (type === 'phases') {
      downloadCsv(`市场阶段-${shortId}.csv`, result,
        ['阶段', '交易日', '累计收益', '年化收益', '年化波动', '最大回撤', '基准收益', '差值'],
        (analysis.marketPhases || []).map((item) => [item.label, item.days, item.cumulativeReturn, item.annualizedReturn, item.volatility, item.maxDrawdown, item.benchmarkReturn, item.excessReturn]));
    }
    if (type === 'contributions') {
      downloadCsv(`证券贡献-${shortId}.csv`, result,
        ['代码', '名称', '行业', '贡献金额', '收益贡献', '买入参考金额', '卖出参考金额', '成交笔数'],
        (analysis.contributions || []).map((item) => [item.assetId, item.name, item.industry, item.amount, item.contribution, item.buyAmount, item.sellAmount, item.tradeCount]));
    }
    if (type === 'holdings') {
      downloadCsv(`当前持仓-${shortId}.csv`, result,
        ['代码', '名称', '行业', '数量', '收盘价', '市值', '权重', '持有收益'],
        result.holdings.map((item) => [item.assetId, item.name, item.industry, item.quantity, item.close, item.marketValue, item.weight, item.returnSinceCost]));
    }
    if (type === 'trades') {
      downloadCsv(`成交明细-${shortId}.csv`, result,
        ['日期', '方向', '代码', '名称', '数量', '成交价', '成交金额', '佣金', '卖出税费', '滑点成本', '费用合计', '原因'],
        filteredTrades(result).map((item) => [item.date, item.side === 'buy' ? '买入' : '卖出', item.assetId, item.name, item.quantity, item.price, item.amount, item.commission ?? '', item.tax ?? '', item.slippageCost ?? '', item.fee, item.reason]));
    }
    showToast('CSV 已导出');
  }

  function refreshContextAndHeader() {
    const panel = document.getElementById('contextPanel');
    if (panel) panel.innerHTML = contextPanelTemplate();
    const savedState = document.querySelector('.page-title-row .state-label');
    if (savedState) {
      savedState.textContent = '有修改';
      savedState.className = 'state-label warning';
    }
    const saveButton = document.getElementById('saveVersion');
    if (saveButton) saveButton.disabled = false;
    const runButton = document.getElementById('runBacktest');
    if (runButton) runButton.disabled = validateDraft().length > 0;
  }

  function applyIdea() {
    const text = appState.idea.trim();
    if (!text) {
      showToast('先写下要验证的策略想法', 'error');
      return;
    }
    const next = clone(appState.ruleDraft);
    const recognized = [];

    // 本地解析只处理明确的常见表达，不能确定的内容保持原值，避免静默猜测。
    const isReal = next.strategyKind === 'price-factor-v1';
    if (!isReal && text.includes('低估值')) {
      next.weights.valuation = 45;
      next.weights.quality = 25;
      next.weights.trend = 20;
      next.weights.stability = 10;
      recognized.push('低估值');
    }
    if (!isReal && (text.includes('高质量') || text.includes('盈利质量'))) {
      next.weights.quality = 40;
      next.weights.valuation = 30;
      next.weights.trend = 20;
      next.weights.stability = 10;
      recognized.push('高质量');
    }
    if (text.includes('趋势') || text.includes('表现较强')) {
      if (isReal) {
        next.weights.trend = 60;
        next.weights.stability = 25;
        next.weights.liquidity = 15;
      } else {
        next.weights.trend = 35;
        const remaining = 65;
        next.weights.valuation = Math.round(remaining * 0.46);
        next.weights.quality = Math.round(remaining * 0.38);
        next.weights.stability = 100 - next.weights.trend - next.weights.valuation - next.weights.quality;
      }
      recognized.push('趋势');
    }
    if (text.includes('低波动') || text.includes('稳定')) {
      next.weights.stability = 40;
      if (isReal) {
        next.weights.trend = 40;
        next.weights.liquidity = 20;
      } else {
        next.weights.valuation = 25;
        next.weights.quality = 20;
        next.weights.trend = 15;
      }
      recognized.push('稳定性');
    }
    if (text.includes('每周')) {
      next.frequency = 'weekly';
      recognized.push('每周调仓');
    } else if (text.includes('每日')) {
      next.frequency = 'daily';
      recognized.push('每日调仓');
    } else if (text.includes('每月')) {
      next.frequency = 'monthly';
      recognized.push('每月调仓');
    }
    const countMatch = text.match(/(?:持有|选择|保留)\s*(\d+)\s*只/);
    if (countMatch) {
      next.topCount = Math.min(appState.bootstrap.dataset.instrumentCount, Math.max(1, Number(countMatch[1])));
      recognized.push(`持有 ${next.topCount} 只`);
    }

    if (!recognized.length) {
      showToast('没有识别到可直接应用的条件，请在下方表单调整', 'error');
      return;
    }
    appState.ruleDraft = next;
    appState.dirty = true;
    renderWorkspace(document.getElementById('pageContent'));
    showToast(`已应用：${recognized.join('、')}`);
  }

  async function persistVersion(silent) {
    const errors = validateDraft();
    if (errors.length) {
      showToast(errors[0], 'error');
      return null;
    }
    try {
      const strategy = getStrategy();
      const payload = await api(`/api/strategies/${encodeURIComponent(strategy.id)}/versions`, {
        method: 'POST',
        body: JSON.stringify({ name: appState.strategyName, note: '规则调整', rules: appState.ruleDraft })
      });
      appState.bootstrap.strategies[0] = payload.strategy;
      appState.dirty = false;
      if (!silent) {
        renderWorkspace(document.getElementById('pageContent'));
        showToast(`已保存为 ${payload.strategy.versions[0].label}`);
      }
      return payload.strategy.currentVersionId;
    } catch (error) {
      showToast(error.message, 'error');
      return null;
    }
  }

  async function runBacktest() {
    const errors = validateDraft();
    if (errors.length) {
      showToast(errors[0], 'error');
      return;
    }
    let versionId = getStrategy().currentVersionId;
    if (appState.dirty) {
      versionId = await persistVersion(true);
      if (!versionId) return;
    }
    appState.running = true;
    renderWorkspace(document.getElementById('pageContent'));
    try {
      const payload = await api('/api/backtests', {
        method: 'POST',
        body: JSON.stringify({ strategyId: getStrategy().id, versionId, rules: appState.ruleDraft })
      });
      appState.bootstrap.latestResult = payload.result;
      appState.bootstrap.jobs.unshift(payload.job);
      appState.activeTab = 'results';
      appState.running = false;
      renderShell();
      showToast(`回测完成，共 ${payload.result.summary.tradeCount} 笔成交`);
    } catch (error) {
      appState.running = false;
      renderWorkspace(document.getElementById('pageContent'));
      showToast(error.message, 'error');
    }
  }

  function loadVersion(versionId) {
    const version = getStrategy().versions.find((item) => item.id === versionId);
    if (!version) return;
    appState.ruleDraft = clone(version.rules);
    appState.dirty = version.id !== getStrategy().currentVersionId;
    appState.activeTab = 'rules';
    renderWorkspace(document.getElementById('pageContent'));
    showToast(`已载入 ${version.label} 的规则`);
  }

  async function reloadBootstrap() {
    try {
      const payload = await api('/api/bootstrap');
      appState.bootstrap = payload;
      appState.marketSelection = payload.instruments.map((item) => ({ ...item }));
      renderShell();
      showToast('本地状态已刷新');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function syncMarketDataFromPage() {
    const button = document.getElementById('syncMarketData');
    const input = document.getElementById('marketCodes');
    const codes = input.value.split(/[，,\s]+/).map((item) => item.trim()).filter(Boolean);
    if (!codes.length || codes.length > 40 || codes.some((code) => !/^\d{6}$/.test(code))) {
      showToast('请输入 1 至 40 个六位证券代码', 'error');
      return;
    }
    button.disabled = true;
    button.innerHTML = '<span class="spinner" style="width:16px;height:16px"></span>更新中';
    try {
      await api('/api/data/sync', { method: 'POST', body: JSON.stringify({ codes }) });
      const payload = await api('/api/bootstrap');
      appState.bootstrap = payload;
      appState.marketSelection = payload.instruments.map((item) => ({ ...item }));
      const strategy = getStrategy();
      appState.strategyName = strategy.name;
      appState.ruleDraft = clone(getCurrentVersion().rules);
      appState.idea = defaultIdea(payload.dataset);
      renderShell();
      showToast(`真实数据已更新至 ${payload.dataset.endDate}`);
    } catch (error) {
      button.disabled = false;
      button.innerHTML = `${icon('refresh', 16)}更新真实数据`;
      showToast(error.message, 'error');
    }
  }

  async function initialize() {
    try {
      const payload = await api('/api/bootstrap');
      appState.bootstrap = payload;
      appState.marketSelection = payload.instruments.map((item) => ({ ...item }));
      const strategy = payload.strategies[0];
      const selectedStrategy = payload.strategies.find((item) => item.id === (payload.dataset.kind === 'real' ? 'strategy-real-momentum' : 'strategy-quality-value')) || strategy;
      appState.strategyName = selectedStrategy.name;
      const version = selectedStrategy.versions.find((item) => item.id === selectedStrategy.currentVersionId) || selectedStrategy.versions[0];
      appState.ruleDraft = clone(version.rules);
      appState.idea = defaultIdea(payload.dataset);
      renderShell();
      const radarAge = Date.now() - Date.parse(payload.latestRadar?.generatedAt || 0);
      if (!payload.latestRadar || radarAge > 30 * 60 * 1000) refreshRadarData();
    } catch (error) {
      appState.error = error.message;
      app.innerHTML = `<div class="error-state">${icon('alert', 34)}<h2>本地服务没有准备好</h2><p>${escapeHtml(error.message)}</p><button class="button" id="retryInit" type="button">${icon('refresh', 16)}重新读取</button></div>`;
      app.setAttribute('aria-busy', 'false');
      document.getElementById('retryInit')?.addEventListener('click', initialize);
    }
  }

  initialize();
})();
