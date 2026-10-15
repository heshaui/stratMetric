const fs = require('fs/promises');
const path = require('path');
const http = require('http');
const https = require('https');

const RADAR_CACHE_FILE = path.join(__dirname, '..', 'data', 'market', 'short-term-radar-v1.json');
const QUOTE_URL = new URL('http://push2.eastmoney.com/api/qt/clist/get');
const NEWS_URL = new URL('https://np-listapi.eastmoney.com/comm/web/getNewsByColumns');
const KLINE_URL = new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
const SINA_KLINE_URL = new URL('https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData');
const MIN_LISTED_DAYS = 120;
const MIN_AMOUNT = 80_000_000;

const DEFAULT_RADAR_SETTINGS = Object.freeze({
  aiEnabled: true,
  capital: 27_000,
  cashReservePercent: 20,
  maxPositions: 3,
  maxSingleAmount: 8_000,
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
});

QUOTE_URL.searchParams.set('pn', '1');
QUOTE_URL.searchParams.set('pz', '100');
QUOTE_URL.searchParams.set('po', '1');
QUOTE_URL.searchParams.set('np', '1');
QUOTE_URL.searchParams.set('fltt', '2');
QUOTE_URL.searchParams.set('invt', '2');
QUOTE_URL.searchParams.set('fid', 'f3');
QUOTE_URL.searchParams.set('fs', 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23');
QUOTE_URL.searchParams.set('fields', 'f2,f3,f5,f6,f8,f10,f12,f14,f15,f16,f17,f18,f20,f21,f22,f24,f25,f26,f62,f100,f124');

NEWS_URL.searchParams.set('client', 'web');
NEWS_URL.searchParams.set('biz', 'web_news_col');
NEWS_URL.searchParams.set('column', '345');
NEWS_URL.searchParams.set('order', '1');
NEWS_URL.searchParams.set('needInteractData', '0');
NEWS_URL.searchParams.set('page_index', '1');
NEWS_URL.searchParams.set('page_size', '30');

const SECTOR_ALIASES = {
  半导体: ['芯片', '半导体', '存储', '晶圆'],
  电池: ['电池', '锂电', '储能', '新能源'],
  电网设备: ['电网', '电力设备', '变压器'],
  汽车零部件: ['汽车', '零部件', '智能驾驶'],
  通信设备: ['通信', '光模块', '卫星通信'],
  计算机设备: ['算力', '服务器', '计算机'],
  软件开发: ['软件', '人工智能', '大模型'],
  消费电子: ['消费电子', '手机', '智能终端'],
  通用设备: ['机器人', '高端装备', '制造业'],
  专用设备: ['机器人', '高端装备', '制造业'],
  化学制药: ['创新药', '医药', '制药'],
  生物制品: ['生物医药', '疫苗', '创新药'],
  电力行业: ['电力', '用电量', '发电'],
  证券: ['证券', '券商', '资本市场'],
  银行: ['银行', '金融'],
  房地产开发: ['房地产', '楼市', '住房'],
  文化传媒: ['传媒', '影视', '游戏']
};

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((finiteNumber(value) + Number.EPSILON) * factor) / factor;
}

function normalizeRadarSettings(input = {}) {
  const settings = { ...DEFAULT_RADAR_SETTINGS, ...input };
  return {
    aiEnabled: settings.aiEnabled !== false,
    capital: round(finiteNumber(settings.capital, DEFAULT_RADAR_SETTINGS.capital), 0),
    cashReservePercent: round(finiteNumber(settings.cashReservePercent, DEFAULT_RADAR_SETTINGS.cashReservePercent), 1),
    maxPositions: Math.round(finiteNumber(settings.maxPositions, DEFAULT_RADAR_SETTINGS.maxPositions)),
    maxSingleAmount: round(finiteNumber(settings.maxSingleAmount, DEFAULT_RADAR_SETTINGS.maxSingleAmount), 0),
    maxPositionPercent: round(finiteNumber(settings.maxPositionPercent, DEFAULT_RADAR_SETTINGS.maxPositionPercent), 1),
    maxRiskPercent: round(finiteNumber(settings.maxRiskPercent, DEFAULT_RADAR_SETTINGS.maxRiskPercent), 2),
    minPrice: round(finiteNumber(settings.minPrice, DEFAULT_RADAR_SETTINGS.minPrice), 2),
    maxPrice: round(finiteNumber(settings.maxPrice, DEFAULT_RADAR_SETTINGS.maxPrice), 2),
    minFloatMarketCapYi: round(finiteNumber(settings.minFloatMarketCapYi, DEFAULT_RADAR_SETTINGS.minFloatMarketCapYi), 1),
    maxFloatMarketCapYi: round(finiteNumber(settings.maxFloatMarketCapYi, DEFAULT_RADAR_SETTINGS.maxFloatMarketCapYi), 1),
    maxTotalMarketCapYi: round(finiteNumber(settings.maxTotalMarketCapYi, DEFAULT_RADAR_SETTINGS.maxTotalMarketCapYi), 1),
    minDailyAmountYi: round(finiteNumber(settings.minDailyAmountYi, DEFAULT_RADAR_SETTINGS.minDailyAmountYi), 1),
    minTurnoverRate: round(finiteNumber(settings.minTurnoverRate, DEFAULT_RADAR_SETTINGS.minTurnoverRate), 1),
    maxTurnoverRate: round(finiteNumber(settings.maxTurnoverRate, DEFAULT_RADAR_SETTINGS.maxTurnoverRate), 1),
    minListedDays: Math.round(finiteNumber(settings.minListedDays, DEFAULT_RADAR_SETTINGS.minListedDays)),
    includeChiNext: settings.includeChiNext === true
  };
}

function validateRadarSettings(input = {}) {
  const settings = normalizeRadarSettings(input);
  const errors = [];
  if (settings.capital < 5_000 || settings.capital > 10_000_000) errors.push('账户资金需要在 5000 元至 1000 万元之间');
  if (settings.cashReservePercent < 0 || settings.cashReservePercent > 80) errors.push('预留现金比例需要在 0% 至 80% 之间');
  if (settings.maxPositions < 1 || settings.maxPositions > 10) errors.push('最多持有数量需要在 1 至 10 只之间');
  if (settings.maxSingleAmount < 1_000 || settings.maxSingleAmount > settings.capital) errors.push('单只金额上限需要在 1000 元至账户资金之间');
  if (settings.maxPositionPercent < 5 || settings.maxPositionPercent > 100) errors.push('单只仓位上限需要在 5% 至 100% 之间');
  if (settings.maxRiskPercent < 0.2 || settings.maxRiskPercent > 10) errors.push('单次计划损失比例需要在 0.2% 至 10% 之间');
  if (settings.minPrice < 1 || settings.maxPrice > 500 || settings.minPrice >= settings.maxPrice) errors.push('价格范围需要在 1 至 500 元之间，且最低价小于最高价');
  if (settings.minFloatMarketCapYi < 0 || settings.minFloatMarketCapYi >= settings.maxFloatMarketCapYi) errors.push('流通市值下限需要小于上限');
  if (settings.maxFloatMarketCapYi > settings.maxTotalMarketCapYi) errors.push('流通市值上限不能大于总市值上限');
  if (settings.minDailyAmountYi < 0.5 || settings.minDailyAmountYi > 100) errors.push('成交额下限需要在 0.5 亿至 100 亿元之间');
  if (settings.minTurnoverRate < 0 || settings.minTurnoverRate >= settings.maxTurnoverRate || settings.maxTurnoverRate > 100) errors.push('换手率下限需要小于上限，且上限不超过 100%');
  if (settings.minListedDays < 30 || settings.minListedDays > 2000) errors.push('上市时间下限需要在 30 至 2000 天之间');
  return errors;
}

function formatShanghaiDate(timestamp) {
  if (!timestamp) return null;
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(timestamp * 1000));
  const values = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseListedDate(value) {
  const text = String(value || '');
  if (!/^\d{8}$/.test(text)) return null;
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function daysBetween(start, end) {
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return 0;
  return Math.floor((endTime - startTime) / 86_400_000);
}

function requestJson(url, timeoutMs = 12_000) {
  const client = url.protocol === 'https:' ? https : http;
  const headers = {
    Accept: 'application/json,text/plain,*/*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
  };
  if (url.hostname.includes('eastmoney')) headers.Referer = 'https://finance.eastmoney.com/';
  if (url.hostname.includes('sina')) headers.Referer = 'https://finance.sina.com.cn/';
  return new Promise((resolve, reject) => {
    const request = client.get(url, {
      headers
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`市场数据服务返回 ${response.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 15 * 1024 * 1024) chunks.push(chunk);
      });
      response.on('end', () => {
        if (size > 15 * 1024 * 1024) {
          reject(new Error('市场数据响应过大'));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(new Error('市场数据格式不正确'));
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('市场数据等待时间过长')));
    request.on('error', reject);
  });
}

function subtractCalendarDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function historyReturn(rows, periods, currentPrice) {
  const base = rows.at(-(periods + 1))?.close;
  return base > 0 ? round((currentPrice / base - 1) * 100) : null;
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function calculateRecentMetrics(inputRows, quote, asOfDate, sessionType, source) {
  let rows = inputRows.filter((row) => row.date <= asOfDate && row.close > 0);

  // 盘中日线可能尚未写入历史接口，用当前快照覆盖最后一天，保证近期位置与页面价格一致。
  const liveRow = {
    date: asOfDate,
    open: quote.open,
    close: quote.price,
    high: quote.high,
    low: quote.low,
    volume: quote.volume,
    amount: quote.amount
  };
  const liveIndex = rows.findIndex((row) => row.date === asOfDate);
  if (liveIndex >= 0) rows[liveIndex] = liveRow;
  else rows.push(liveRow);
  rows = rows.sort((left, right) => left.date.localeCompare(right.date)).slice(-80);
  if (rows.length < 22) throw new Error('近期日线长度不足');

  const currentPrice = quote.price;
  const recent20 = rows.slice(-20);
  const recent60 = rows.slice(-60);
  const ma5 = average(rows.slice(-5).map((row) => row.close));
  const ma10 = average(rows.slice(-10).map((row) => row.close));
  const ma20 = average(recent20.map((row) => row.close));
  const high20 = Math.max(...recent20.map((row) => row.high));
  const high60 = Math.max(...recent60.map((row) => row.high));
  const high20Index = recent20.reduce((best, row, index) => row.high >= recent20[best].high ? index : best, 0);
  const completedRows = sessionType === 'intraday' ? rows.filter((row) => row.date < asOfDate) : rows;
  let pullbackDays = 0;
  for (let index = completedRows.length - 1; index > 0; index -= 1) {
    if (completedRows[index].close >= completedRows[index - 1].close) break;
    pullbackDays += 1;
  }

  return {
    source,
    asOfDate,
    dataPoints: rows.length,
    return5d: historyReturn(rows, 5, currentPrice),
    return10d: historyReturn(rows, 10, currentPrice),
    return20d: historyReturn(rows, 20, currentPrice),
    ma5: round(ma5),
    ma10: round(ma10),
    ma20: round(ma20),
    ma20Deviation: ma20 > 0 ? round((currentPrice / ma20 - 1) * 100) : null,
    distanceTo20High: high20 > 0 ? round((currentPrice / high20 - 1) * 100) : null,
    distanceTo60High: high60 > 0 ? round((currentPrice / high60 - 1) * 100) : null,
    recentPeakAge: recent20.length - 1 - high20Index,
    pullbackDays
  };
}

async function fetchEastmoneyRecentMetrics(quote, asOfDate, sessionType) {
  const url = new URL(KLINE_URL);
  url.searchParams.set('secid', `${quote.code.startsWith('6') ? '1' : '0'}.${quote.code}`);
  url.searchParams.set('klt', '101');
  url.searchParams.set('fqt', '1');
  url.searchParams.set('beg', subtractCalendarDays(asOfDate, 140));
  url.searchParams.set('end', asOfDate.replace(/-/g, ''));
  url.searchParams.set('lmt', '100');
  url.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6');
  url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61');
  const payload = await requestJson(url, 12_000);
  const lines = payload?.data?.klines;
  if (!Array.isArray(lines) || !lines.length) throw new Error('没有取得近期日线');

  const rows = lines.map((line) => String(line).split(',')).filter((row) => row.length >= 7).map((row) => ({
    date: row[0],
    open: finiteNumber(row[1]),
    close: finiteNumber(row[2]),
    high: finiteNumber(row[3]),
    low: finiteNumber(row[4]),
    volume: finiteNumber(row[5]),
    amount: finiteNumber(row[6])
  }));
  return calculateRecentMetrics(rows, quote, asOfDate, sessionType, '东方财富近期日线');
}

async function fetchSinaRecentMetrics(quote, asOfDate, sessionType) {
  const url = new URL(SINA_KLINE_URL);
  url.searchParams.set('symbol', `${quote.code.startsWith('6') ? 'sh' : 'sz'}${quote.code}`);
  url.searchParams.set('scale', '240');
  url.searchParams.set('ma', 'no');
  url.searchParams.set('datalen', '80');
  const payload = await requestJson(url, 12_000);
  if (!Array.isArray(payload) || !payload.length) throw new Error('备用服务没有取得近期日线');
  const rows = payload.map((row) => ({
    date: String(row.day || '').slice(0, 10),
    open: finiteNumber(row.open),
    close: finiteNumber(row.close),
    high: finiteNumber(row.high),
    low: finiteNumber(row.low),
    volume: finiteNumber(row.volume),
    amount: 0
  }));
  return calculateRecentMetrics(rows, quote, asOfDate, sessionType, '新浪近期日线');
}

async function fetchRecentMetrics(quote, asOfDate, sessionType) {
  try {
    return await fetchEastmoneyRecentMetrics(quote, asOfDate, sessionType);
  } catch (primaryError) {
    try {
      return await fetchSinaRecentMetrics(quote, asOfDate, sessionType);
    } catch (fallbackError) {
      throw new Error(`近期日线不可用：${primaryError.message}；备用服务：${fallbackError.message}`);
    }
  }
}

async function enrichRadarSnapshotHistory(snapshot, codes = []) {
  const uniqueCodes = [...new Set(codes.map(String))].slice(0, 20);
  if (!uniqueCodes.length) return snapshot;
  const quoteByCode = new Map(snapshot.quotes.map((quote) => [quote.code, quote]));
  const session = marketSession(snapshot);
  const metricsByCode = new Map();

  // 限制并发和总数量，避免一次刷新给公开数据服务造成过大压力；失败项保留原快照并明确标记。
  for (let start = 0; start < uniqueCodes.length; start += 4) {
    const batch = uniqueCodes.slice(start, start + 4);
    const results = await Promise.allSettled(batch.map((code) => {
      const quote = quoteByCode.get(code);
      return quote ? fetchRecentMetrics(quote, snapshot.asOfDate, session.type) : Promise.reject(new Error('证券不在快照中'));
    }));
    results.forEach((result, index) => {
      metricsByCode.set(batch[index], result.status === 'fulfilled'
        ? { recentMetrics: result.value, historyStatus: 'ready' }
        : { recentMetrics: null, historyStatus: 'unavailable', historyError: result.reason?.message || '近期日线不可用' });
    });
  }

  return {
    ...snapshot,
    historyCoverage: {
      requested: uniqueCodes.length,
      available: [...metricsByCode.values()].filter((item) => item.historyStatus === 'ready').length
    },
    quotes: snapshot.quotes.map((quote) => metricsByCode.has(quote.code) ? { ...quote, ...metricsByCode.get(quote.code) } : quote)
  };
}

async function enrichRadarCandidateHistory(snapshot, news, inputSettings) {
  const preliminaryRadar = buildRadar(snapshot, news, [], inputSettings);
  const historyCodes = preliminaryRadar.candidatePool
    .filter((item) => item.historyStatus !== 'ready')
    .map((item) => item.code);
  return enrichRadarSnapshotHistory(snapshot, historyCodes);
}

async function fetchAllMarketRows() {
  const firstPayload = await requestJson(QUOTE_URL, 18_000);
  const firstRows = firstPayload?.data?.diff;
  const total = finiteNumber(firstPayload?.data?.total);
  if (!Array.isArray(firstRows) || !firstRows.length || total <= 0) throw new Error('没有取得可用的全市场行情');
  const pageSize = 100;
  const pageCount = Math.ceil(total / pageSize);
  const pages = Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => index + 2);
  const allRows = [...firstRows];

  // 数据源限制单页数量，分组并发可以在避免请求过密的同时完成全市场覆盖。
  for (let start = 0; start < pages.length; start += 8) {
    const batch = pages.slice(start, start + 8);
    const payloads = await Promise.all(batch.map(async (page) => {
      const pageUrl = new URL(QUOTE_URL);
      pageUrl.searchParams.set('pn', String(page));
      try {
        return await requestJson(pageUrl, 18_000);
      } catch (error) {
        return requestJson(pageUrl, 18_000);
      }
    }));
    payloads.forEach((payload) => {
      if (Array.isArray(payload?.data?.diff)) allRows.push(...payload.data.diff);
    });
  }
  const uniqueRows = [...new Map(allRows.map((row) => [String(row.f12 || ''), row])).values()];
  if (uniqueRows.length < total * 0.9) throw new Error(`全市场行情不完整，当前仅取得 ${uniqueRows.length} 条`);
  return { data: { total, diff: uniqueRows } };
}

function normalizeQuote(row) {
  return {
    code: String(row.f12 || ''),
    name: String(row.f14 || row.f12 || ''),
    price: finiteNumber(row.f2),
    changePercent: finiteNumber(row.f3),
    volume: finiteNumber(row.f5),
    amount: finiteNumber(row.f6),
    turnoverRate: finiteNumber(row.f8),
    volumeRatio: finiteNumber(row.f10),
    high: finiteNumber(row.f15),
    low: finiteNumber(row.f16),
    open: finiteNumber(row.f17),
    previousClose: finiteNumber(row.f18),
    marketValue: finiteNumber(row.f20),
    floatMarketValue: finiteNumber(row.f21),
    speed: finiteNumber(row.f22),
    change60d: finiteNumber(row.f24),
    changeYear: finiteNumber(row.f25),
    listedDate: parseListedDate(row.f26),
    netInflow: finiteNumber(row.f62),
    sector: String(row.f100 || '未分类'),
    quoteTime: finiteNumber(row.f124)
  };
}

function isOnePriceLimit(quote) {
  const limit = quote.code.startsWith('30') ? 19.5 : 9.5;
  return quote.changePercent >= limit && quote.high > 0 && Math.abs(quote.high - quote.low) < 0.001;
}

function quoteEligibilityIssues(quote, asOfDate, inputSettings = DEFAULT_RADAR_SETTINGS) {
  const settings = normalizeRadarSettings(inputSettings);
  const issues = [];
  if (!/^(00|30|60)\d{4}$/.test(quote.code)) issues.push('不在当前沪深普通证券范围');
  if (quote.code.startsWith('688') || quote.code.startsWith('689')) issues.push('当前范围排除科创板');
  if (quote.code.startsWith('30') && !settings.includeChiNext) issues.push('当前设置未包含创业板');
  if (/ST|退/i.test(quote.name) || quote.name.startsWith('N') || quote.name.startsWith('C')) issues.push('名称或上市状态不符合当前范围');
  if (!quote.listedDate || daysBetween(quote.listedDate, asOfDate) < settings.minListedDays) issues.push(`上市时间不足 ${settings.minListedDays} 天`);
  if (quote.price < settings.minPrice || quote.price > settings.maxPrice) issues.push(`价格不在 ${settings.minPrice} 至 ${settings.maxPrice} 元范围`);
  if (quote.previousClose <= 0) issues.push('缺少有效的前收盘价');
  if (quote.amount < settings.minDailyAmountYi * 100_000_000) issues.push(`成交额低于 ${settings.minDailyAmountYi} 亿元`);
  if (quote.turnoverRate < settings.minTurnoverRate || quote.turnoverRate > settings.maxTurnoverRate) issues.push(`换手率不在 ${settings.minTurnoverRate}% 至 ${settings.maxTurnoverRate}% 范围`);
  const floatMarketValue = quote.floatMarketValue || quote.marketValue;
  if (floatMarketValue < settings.minFloatMarketCapYi * 100_000_000 || floatMarketValue > settings.maxFloatMarketCapYi * 100_000_000) {
    issues.push(`流通市值不在 ${settings.minFloatMarketCapYi} 至 ${settings.maxFloatMarketCapYi} 亿元范围`);
  }
  if (quote.marketValue > settings.maxTotalMarketCapYi * 100_000_000) issues.push(`总市值高于 ${settings.maxTotalMarketCapYi} 亿元`);
  if (isOnePriceLimit(quote)) issues.push('当前处于难以正常成交的极端状态');
  return issues;
}

function isEligibleQuote(quote, asOfDate, inputSettings = DEFAULT_RADAR_SETTINGS) {
  return quoteEligibilityIssues(quote, asOfDate, inputSettings).length === 0;
}

function percentileRanks(items, getter) {
  const sorted = [...items].sort((left, right) => getter(left) - getter(right));
  const result = new Map();
  sorted.forEach((item, index) => result.set(item, sorted.length <= 1 ? 1 : index / (sorted.length - 1)));
  return result;
}

function newsKeywordsForSector(sector) {
  return [sector, ...(SECTOR_ALIASES[sector] || [])].filter((item) => item && item !== '未分类');
}

function relateNews(news, sectors) {
  return news.map((item) => {
    const text = `${item.title} ${item.summary}`;
    const relatedSectors = sectors.filter((sector) => newsKeywordsForSector(sector).some((keyword) => text.includes(keyword)));
    return { ...item, relatedSectors: relatedSectors.slice(0, 4) };
  }).filter((item) => item.relatedSectors.length);
}

function buildSectorRows(quotes, news) {
  const groups = new Map();
  quotes.forEach((quote) => {
    if (quote.sector === '未分类') return;
    const rows = groups.get(quote.sector) || [];
    rows.push(quote);
    groups.set(quote.sector, rows);
  });
  const relatedNews = relateNews(news, [...groups.keys()]);
  const rows = [...groups.entries()].map(([name, members]) => {
    const total = members.length;
    const avgChange = members.reduce((sum, item) => sum + item.changePercent, 0) / total;
    const advancers = members.filter((item) => item.changePercent > 0).length;
    const strongCount = members.filter((item) => item.changePercent >= 5).length;
    const limitUpCount = members.filter((item) => item.changePercent >= (item.code.startsWith('30') ? 19.5 : 9.5)).length;
    return {
      name,
      total,
      avgChange,
      breadth: advancers / total,
      strongRatio: strongCount / total,
      limitUpCount,
      amount: members.reduce((sum, item) => sum + item.amount, 0),
      netInflow: members.reduce((sum, item) => sum + item.netInflow, 0),
      news: relatedNews.filter((item) => item.relatedSectors.includes(name)).slice(0, 3)
    };
  }).filter((item) => item.total >= 5);

  const changeRanks = percentileRanks(rows, (item) => item.avgChange);
  const breadthRanks = percentileRanks(rows, (item) => item.breadth);
  const strongRanks = percentileRanks(rows, (item) => item.strongRatio);
  const amountRanks = percentileRanks(rows, (item) => Math.log10(Math.max(1, item.amount)));
  const flowRanks = percentileRanks(rows, (item) => item.netInflow);

  rows.forEach((item) => {
    const newsBonus = Math.min(10, item.news.length * 4);
    item.heatScore = round(
      changeRanks.get(item) * 35 +
      breadthRanks.get(item) * 22 +
      strongRanks.get(item) * 18 +
      amountRanks.get(item) * 10 +
      flowRanks.get(item) * 5 +
      newsBonus,
      0
    );
  });
  return rows.sort((left, right) => right.heatScore - left.heatScore);
}

function bandScore(value, idealMinimum, idealMaximum, outerMinimum, outerMaximum) {
  const number = finiteNumber(value, outerMinimum);
  if (number >= idealMinimum && number <= idealMaximum) return 100;
  if (number <= outerMinimum || number >= outerMaximum) return 0;
  if (number < idealMinimum) return round((number - outerMinimum) / (idealMinimum - outerMinimum) * 100, 0);
  return round((outerMaximum - number) / (outerMaximum - idealMaximum) * 100, 0);
}

function marketSession(snapshot) {
  const latestTimestamp = Math.max(0, ...(snapshot.quotes || []).map((item) => finiteNumber(item.quoteTime)));
  if (!latestTimestamp) return { type: 'closed', label: '收盘快照', quoteTime: null };
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(latestTimestamp * 1000));
  const values = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  const quoteDate = `${values.year}-${values.month}-${values.day}`;
  const minuteOfDay = finiteNumber(values.hour) * 60 + finiteNumber(values.minute);
  const isTradingTime = quoteDate === snapshot.asOfDate && minuteOfDay >= 9 * 60 + 15 && minuteOfDay < 15 * 60;
  return {
    type: isTradingTime ? 'intraday' : 'closed',
    label: isTradingTime ? '盘中观察快照' : '收盘快照',
    quoteTime: new Date(latestTimestamp * 1000).toISOString()
  };
}

function candidateFactorProfile(quote, sector, mood) {
  const gapPercent = quote.previousClose > 0 ? (quote.open / quote.previousClose - 1) * 100 : 0;
  const amplitude = quote.previousClose > 0 ? (quote.high - quote.low) / quote.previousClose * 100 : 0;
  const closeLocation = quote.high > quote.low ? (quote.price - quote.low) / (quote.high - quote.low) * 100 : 50;
  const amountYi = quote.amount / 100_000_000;
  const floatMarketValueYi = (quote.floatMarketValue || quote.marketValue) / 100_000_000;
  const recent = quote.recentMetrics?.dataPoints >= 22 ? quote.recentMetrics : null;

  const positionScore = recent
    ? round(
      bandScore(quote.change60d, 0, 15, -20, 35) * 0.25 +
      bandScore(quote.changeYear, -5, 35, -35, 80) * 0.2 +
      bandScore(recent.return20d, 0, 12, -15, 22) * 0.2 +
      bandScore(recent.ma20Deviation, -2, 8, -12, 15) * 0.2 +
      bandScore(recent.distanceTo20High, -15, -5, -30, 0.5) * 0.15,
      0
    )
    : round(
      bandScore(quote.change60d, 0, 15, -20, 35) * 0.4 +
      bandScore(quote.changeYear, -5, 35, -35, 80) * 0.25 +
      bandScore(quote.changePercent, 0.5, 4, -2, 7) * 0.2 +
      bandScore(gapPercent, -0.5, 2, -4, 4) * 0.15,
      0
    );
  const trendScore = recent
    ? round(
      bandScore(recent.return5d, 0.5, 6, -8, 12) * 0.25 +
      bandScore(recent.return10d, 1, 10, -10, 18) * 0.25 +
      bandScore(recent.return20d, 2, 15, -15, 25) * 0.25 +
      bandScore(closeLocation, 58, 92, 20, 101) * 0.25,
      0
    )
    : round(
      bandScore(quote.change60d, 2, 20, -15, 35) * 0.4 +
      bandScore(quote.changeYear, 0, 45, -35, 90) * 0.2 +
      bandScore(quote.changePercent, 0.5, 5, -2, 7) * 0.25 +
      bandScore(closeLocation, 60, 95, 20, 101) * 0.15,
      0
    );

  // 每项都采用“合理区间得高分、过低或过热递减”的形状，避免把单日涨幅越大简单解释为越好。
  const factorScores = {
    position: positionScore,
    trend: trendScore,
    volume: round(
      bandScore(quote.volumeRatio, 1.1, 2.8, 0.5, 5.5) * 0.55 +
      bandScore(quote.turnoverRate, 4, 12, 1, 20) * 0.45,
      0
    ),
    sector: round(clamp(sector?.heatScore || 0, 0, 100), 0),
    structure: round(
      bandScore(gapPercent, -0.5, 2.5, -4, 4) * 0.4 +
      bandScore(amplitude, 2, 7, 0.3, 12) * 0.35 +
      bandScore(closeLocation, 58, 92, 20, 101) * 0.25,
      0
    ),
    market: round(bandScore(mood?.score || 0, 50, 68, 28, 85), 0),
    liquidity: round(
      bandScore(amountYi, 3, 20, 0.8, 50) * 0.6 +
      bandScore(floatMarketValueYi, 30, 150, 12, 260) * 0.4,
      0
    )
  };

  const overheatReasons = [];
  if (quote.changePercent >= 7) overheatReasons.push(`当日涨幅 ${round(quote.changePercent)}% 已进入追高风险区`);
  if (quote.change60d >= 35) overheatReasons.push(`近 60 日涨幅 ${round(quote.change60d)}%，位置偏高`);
  if (quote.changeYear >= 80) overheatReasons.push(`今年以来涨幅 ${round(quote.changeYear)}%，中期位置过高`);
  if (gapPercent >= 4) overheatReasons.push(`相对前收高开 ${round(gapPercent)}%，高开幅度过大`);
  if (quote.volumeRatio >= 5.5) overheatReasons.push(`量比 ${round(quote.volumeRatio, 1)}，短时放量过度`);
  if (amplitude >= 12) overheatReasons.push(`日内振幅 ${round(amplitude)}%，波动异常放大`);
  if (recent?.return20d >= 20) overheatReasons.push(`近 20 日上涨 ${round(recent.return20d)}%，短期涨幅过大`);
  if (recent?.ma20Deviation >= 15) overheatReasons.push(`现价高于 20 日均线 ${round(recent.ma20Deviation)}%，偏离过大`);
  if (recent && recent.distanceTo20High >= -5 && recent.return20d >= 12 && recent.recentPeakAge <= 5) {
    overheatReasons.push(`距离 20 日高点仅 ${round(Math.abs(recent.distanceTo20High))}%，仍处于阶段高位`);
  }
  if (recent && recent.pullbackDays >= 2 && recent.distanceTo20High >= -8 && (recent.return20d >= 10 || quote.change60d >= 20)) {
    overheatReasons.push(`阶段高位附近连续回调 ${recent.pullbackDays} 天，暂不抢反弹`);
  }

  const score = round(
    factorScores.position * 0.25 +
    factorScores.trend * 0.18 +
    factorScores.volume * 0.17 +
    factorScores.sector * 0.15 +
    factorScores.structure * 0.1 +
    factorScores.market * 0.1 +
    factorScores.liquidity * 0.05,
    0
  );
  const confirmationReady = score >= 68 &&
    quote.changePercent >= 1.2 && quote.changePercent <= 5.8 &&
    quote.volumeRatio >= 1 && quote.volumeRatio <= 3.5 &&
    closeLocation >= 58 && finiteNumber(sector?.rank, 999) <= 10;

  return {
    score,
    stage: overheatReasons.length ? '过热回避' : confirmationReady ? '启动确认' : '潜伏观察',
    factorScores,
    overheatReasons,
    recentMetrics: recent,
    historyStatus: quote.historyStatus || (recent ? 'ready' : 'not-requested'),
    gapPercent: round(gapPercent),
    amplitude: round(amplitude),
    closeLocation: round(closeLocation, 0)
  };
}

function scoreCandidate(quote, sector, mood) {
  return candidateFactorProfile(quote, sector, mood).score;
}

function candidatePlan(quote, sector, profile, session) {
  const referenceLow = Math.min(quote.low || quote.price, quote.previousClose || quote.price);
  const invalidationPrice = round(referenceLow * 0.99);
  const reasons = [
    `${sector.name}热度 ${sector.heatScore}，当前排名第 ${sector.rank}`,
    `位置 ${profile.factorScores.position} 分，趋势 ${profile.factorScores.trend} 分，量能 ${profile.factorScores.volume} 分`,
    `当日涨幅 ${round(quote.changePercent)}%，近 60 日涨幅 ${round(quote.change60d)}%，收盘位置 ${profile.closeLocation}%`
  ];
  if (profile.recentMetrics) {
    reasons.push(`近 20 日涨幅 ${round(profile.recentMetrics.return20d)}%，距 20 日高点 ${round(profile.recentMetrics.distanceTo20High)}%，20 日均线偏离 ${round(profile.recentMetrics.ma20Deviation)}%`);
    if (profile.recentMetrics.pullbackDays) reasons.push(`最近完整交易日已连续回调 ${profile.recentMetrics.pullbackDays} 天`);
  } else {
    reasons.push(`今年以来涨幅 ${round(quote.changeYear)}%，近期日线路径暂未补齐`);
  }
  if (sector.news.length) reasons.push(`当前有 ${sector.news.length} 条相关方向资讯，仅作为辅助信息`);

  if (profile.overheatReasons.length) {
    return {
      action: '过热回避',
      actionTone: 'board',
      entryCondition: '不进入普通候选；等待价格充分整理、量能恢复正常并重新通过风险门后再评估。',
      invalidation: '当前不制定进入计划，避免在短时情绪高点追价。',
      invalidationPrice,
      reasons: [...profile.overheatReasons, ...reasons]
    };
  }

  if (session.type === 'intraday') {
    const confirmationText = profile.stage === '启动确认'
      ? `等待收盘仍保持在 ${round(quote.previousClose)} 元上方，且量比不超过 3.5。`
      : `等待收盘站稳 ${round(quote.high)} 元附近，并确认量能没有异常放大。`;
    return {
      action: profile.stage,
      actionTone: profile.stage === '启动确认' ? 'watch' : 'wait',
      entryCondition: `当前仅作盘中观察；${confirmationText}`,
      invalidation: `收盘跌破 ${invalidationPrice} 元，或方向热度跌出前二十时停止观察。`,
      invalidationPrice,
      reasons
    };
  }

  if (profile.stage === '启动确认') {
    return {
      action: '启动确认',
      actionTone: 'watch',
      entryCondition: `下一交易日高开不超过 2.5%，回踩不破 ${round(quote.previousClose)} 元并重新站上开盘价后再观察。`,
      invalidation: `跌破 ${invalidationPrice} 元，或方向热度跌出前二十时停止观察。`,
      invalidationPrice,
      reasons
    };
  }

  return {
    action: '潜伏观察',
    actionTone: 'wait',
    entryCondition: `下一交易日放量站上 ${round(quote.high)} 元，且所属方向保持前十五后再观察。`,
    invalidation: `跌破 ${invalidationPrice} 元，或量能持续低于正常水平时停止观察。`,
    invalidationPrice,
    reasons
  };
}

function buildFundingPlan(price, invalidationPrice, inputSettings) {
  const settings = normalizeRadarSettings(inputSettings);
  const availableCapital = settings.capital * (1 - settings.cashReservePercent / 100);
  const budgetLimit = Math.min(
    settings.maxSingleAmount,
    settings.capital * settings.maxPositionPercent / 100,
    availableCapital / settings.maxPositions
  );
  const riskLimit = settings.capital * settings.maxRiskPercent / 100;
  const riskPerShare = Math.max(0.01, price - invalidationPrice);
  const quantityByBudget = Math.floor(budgetLimit / price / 100) * 100;
  const quantityByRisk = Math.floor(riskLimit / riskPerShare / 100) * 100;
  const quantity = Math.max(0, Math.min(quantityByBudget, quantityByRisk));
  const plannedAmount = round(quantity * price, 0);
  return {
    quantity,
    plannedAmount,
    positionPercent: round(plannedAmount / settings.capital * 100, 1),
    plannedLoss: round(quantity * riskPerShare, 0),
    riskPercent: round(quantity * riskPerShare / settings.capital * 100, 2),
    limitingFactor: quantityByRisk < quantityByBudget ? '计划损失' : '可用金额'
  };
}

function buildCandidates(quotes, sectors, settings, mood, session) {
  const sectorMap = new Map(sectors.map((item, index) => [item.name, { ...item, rank: index + 1 }]));
  const ranked = quotes
    .map((quote) => ({ quote, sector: sectorMap.get(quote.sector) }))
    .filter((item) => item.sector && item.sector.rank <= 20 && item.quote.changePercent > 0.3)
    .map((item) => {
      const profile = candidateFactorProfile(item.quote, item.sector, mood);
      const plan = candidatePlan(item.quote, item.sector, profile, session);
      return {
        ...item,
        profile,
        plan,
        funding: buildFundingPlan(item.quote.price, plan.invalidationPrice, settings),
        score: profile.score
      };
    })
    .sort((left, right) => right.score - left.score);

  const regularRanked = ranked.filter((item) => !item.profile.overheatReasons.length && item.funding.quantity >= 100);
  const overheatedRanked = ranked.filter((item) => item.profile.overheatReasons.length);

  function toCandidate(item, ruleRank) {
    return {
      code: item.quote.code,
      name: item.quote.name,
      sector: item.sector.name,
      sectorRank: item.sector.rank,
      ruleRank,
      score: item.score,
      price: round(item.quote.price),
      changePercent: round(item.quote.changePercent),
      turnoverRate: round(item.quote.turnoverRate),
      volumeRatio: round(item.quote.volumeRatio),
      amount: item.quote.amount,
      floatMarketValue: item.quote.floatMarketValue || item.quote.marketValue,
      marketValue: item.quote.marketValue,
      change60d: round(item.quote.change60d),
      changeYear: round(item.quote.changeYear),
      stage: item.profile.stage,
      factorScores: item.profile.factorScores,
      recentMetrics: item.profile.recentMetrics,
      historyStatus: item.profile.historyStatus,
      gapPercent: item.profile.gapPercent,
      amplitude: item.profile.amplitude,
      closeLocation: item.profile.closeLocation,
      riskGate: item.profile.overheatReasons.length ? 'blocked' : 'passed',
      overheatReasons: item.profile.overheatReasons,
      funding: item.funding,
      ...item.plan
    };
  }

  // 高位风险门在候选池形成前执行，后续 AI 只能看到已经通过风险门的证券。
  const candidatePool = [];
  const poolSectorCounts = new Map();
  for (const item of regularRanked) {
    const count = poolSectorCounts.get(item.sector.name) || 0;
    if (count >= 2) continue;
    poolSectorCounts.set(item.sector.name, count + 1);
    candidatePool.push(toCandidate(item, candidatePool.length + 1));
    if (candidatePool.length === 12) break;
  }

  const selected = [];
  const selectedSectors = new Set();
  const selectionLimit = Math.min(
    settings.maxPositions,
    mood.score < 50 ? 1 : mood.score < 55 ? 2 : 3
  );
  for (const item of candidatePool) {
    if (selectedSectors.has(item.sector)) continue;
    selectedSectors.add(item.sector);
    selected.push(item);
    if (selected.length === selectionLimit) break;
  }

  const overheatWatch = overheatedRanked
    .slice(0, 5)
    .map((item) => ({
      code: item.quote.code,
      name: item.quote.name,
      sector: item.quote.sector,
      price: round(item.quote.price),
      changePercent: round(item.quote.changePercent),
      turnoverRate: round(item.quote.turnoverRate),
      amount: item.quote.amount,
      score: item.score,
      overheatReasons: item.profile.overheatReasons,
      note: item.profile.overheatReasons.join('；')
    }));
  return { candidates: selected, candidatePool, selectionLimit, overheatWatch, boardWatch: overheatWatch };
}

function marketMood(quotes) {
  const advancers = quotes.filter((item) => item.changePercent > 0).length;
  const decliners = quotes.filter((item) => item.changePercent < 0).length;
  const flat = quotes.length - advancers - decliners;
  const limitUp = quotes.filter((item) => item.changePercent >= (item.code.startsWith('30') ? 19.5 : 9.5)).length;
  const limitDown = quotes.filter((item) => item.changePercent <= (item.code.startsWith('30') ? -19.5 : -9.5)).length;
  const breadth = quotes.length ? advancers / quotes.length : 0;
  const score = round(clamp(50 + (breadth - 0.5) * 65 + (limitUp - limitDown) / Math.max(quotes.length, 1) * 180, 0, 100), 0);
  const label = score >= 72 ? '偏热' : score >= 55 ? '回暖' : score >= 40 ? '分化' : '偏冷';
  const positionHint = score >= 72 ? '情绪较热，控制追高节奏' : score >= 55 ? '可以试错，但需要执行失效条件' : score >= 40 ? '轻仓等待强方向确认' : '优先防守，减少主动出手';
  return {
    score,
    label,
    positionHint,
    total: quotes.length,
    advancers,
    decliners,
    flat,
    limitUp,
    limitDown,
    breadth: round(breadth * 100, 1),
    amount: quotes.reduce((sum, item) => sum + item.amount, 0)
  };
}

function holdingDecision(holding, quote, sectorMap) {
  if (!quote) return { ...holding, action: '等待数据', actionTone: 'wait', note: '当前快照没有这只证券，请刷新后再判断。' };
  const sector = sectorMap.get(quote.sector);
  const profitPercent = holding.cost > 0 ? (quote.price / holding.cost - 1) * 100 : null;
  const amplitude = quote.previousClose > 0 ? (quote.high - quote.low) / quote.previousClose * 100 : 0;
  let action = '继续持有';
  let actionTone = 'hold';
  let note = '板块仍有强度，收盘未明显转弱；跌破今日最低价时重新评估。';
  if (quote.changePercent <= -5 || (profitPercent !== null && profitPercent <= -8) || !sector || sector.rank > 20) {
    action = '考虑退出';
    actionTone = 'exit';
    note = '价格或板块强度已经转弱；次日不能快速收复今日开盘价时，优先控制仓位。';
  } else if (profitPercent !== null && profitPercent >= 3 && amplitude >= 4) {
    action = '做T条件';
    actionTone = 'trade';
    note = '已有浮盈且日内波动较大；冲高时只降低部分仓位，回落企稳后再考虑接回。';
  }
  return {
    ...holding,
    name: quote.name || holding.name,
    sector: quote.sector,
    price: round(quote.price),
    changePercent: round(quote.changePercent),
    profitPercent: profitPercent === null ? null : round(profitPercent),
    marketValue: round(quote.price * holding.quantity),
    action,
    actionTone,
    note
  };
}

function marketScopeSettings(inputSettings) {
  const settings = normalizeRadarSettings(inputSettings);
  return {
    ...DEFAULT_RADAR_SETTINGS,
    minPrice: 1,
    maxPrice: 500,
    minFloatMarketCapYi: 0,
    maxFloatMarketCapYi: 100_000,
    maxTotalMarketCapYi: 100_000,
    minDailyAmountYi: MIN_AMOUNT / 100_000_000,
    minTurnoverRate: 0,
    maxTurnoverRate: 100,
    minListedDays: MIN_LISTED_DAYS,
    includeChiNext: settings.includeChiNext
  };
}

function buildRadar(snapshot, news = [], holdings = [], inputSettings = DEFAULT_RADAR_SETTINGS) {
  const asOfDate = snapshot.asOfDate;
  const settings = normalizeRadarSettings(inputSettings);
  const marketQuotes = snapshot.quotes.filter((quote) => isEligibleQuote(quote, asOfDate, marketScopeSettings(settings)));
  const eligibleQuotes = snapshot.quotes.filter((quote) => isEligibleQuote(quote, asOfDate, settings));
  const sectors = buildSectorRows(marketQuotes, news).map((item, index) => ({ ...item, rank: index + 1 }));
  const mood = marketMood(marketQuotes);
  const session = marketSession(snapshot);
  const { candidates, candidatePool, selectionLimit, overheatWatch, boardWatch } = buildCandidates(eligibleQuotes, sectors, settings, mood, session);
  const quoteMap = new Map(snapshot.quotes.map((item) => [item.code, item]));
  const sectorMap = new Map(sectors.map((item) => [item.name, item]));
  const relatedNews = relateNews(news, sectors.slice(0, 12).map((item) => item.name)).slice(0, 6);
  return {
    version: 'short-term-radar-v2',
    generatedAt: new Date().toISOString(),
    asOfDate,
    source: snapshot.source,
    stale: Boolean(snapshot.stale),
    fallbackReason: snapshot.fallbackReason || null,
    scope: {
      rawCount: snapshot.quotes.length,
      marketCount: marketQuotes.length,
      eligibleCount: eligibleQuotes.length,
      excluded: [
        '科创板和风险标记证券',
        `${settings.minPrice} 至 ${settings.maxPrice} 元范围之外`,
        `流通市值不在 ${settings.minFloatMarketCapYi} 至 ${settings.maxFloatMarketCapYi} 亿元`,
        `成交额低于 ${settings.minDailyAmountYi} 亿元`,
        `换手率不在 ${settings.minTurnoverRate}% 至 ${settings.maxTurnoverRate}%`,
        `上市不足 ${settings.minListedDays} 天`,
        '难以正常成交的极端状态'
      ]
    },
    settings,
    mood,
    session,
    selectionLimit,
    sectors: sectors.slice(0, 8),
    candidates,
    candidatePool,
    overheatWatch,
    boardWatch,
    news: relatedNews,
    holdings: holdings.map((holding) => holdingDecision(holding, quoteMap.get(holding.code), sectorMap)),
    assumptions: [
      session.type === 'intraday' ? '盘中结果只用于观察，需等待收盘确认' : '依据最近一个完整收盘快照生成下一交易日计划',
      '先执行高位风险门，再按七类短线因子排序',
      '入场、退出和做T均为条件式观察，不会自动执行',
      '结果用于未来 1 至 5 个交易日的观察，不代表确定走势'
    ]
  };
}

function analyzeStock(snapshot, news = [], code, inputSettings = DEFAULT_RADAR_SETTINGS) {
  const settings = normalizeRadarSettings(inputSettings);
  const normalizedCode = String(code || '').trim();
  const quote = snapshot.quotes.find((item) => item.code === normalizedCode);
  if (!quote) {
    const error = new Error('当前全市场快照中没有找到该证券');
    error.statusCode = 404;
    throw error;
  }

  // 单股结论必须和首页使用同一市场温度、方向排名与个人条件，避免两个入口给出相反判断。
  const marketQuotes = snapshot.quotes.filter((item) => isEligibleQuote(item, snapshot.asOfDate, marketScopeSettings(settings)));
  const sectors = buildSectorRows(marketQuotes, news).map((item, index) => ({ ...item, rank: index + 1 }));
  const sector = sectors.find((item) => item.name === quote.sector) || null;
  const mood = marketMood(marketQuotes);
  const session = marketSession(snapshot);
  const issues = quoteEligibilityIssues(quote, snapshot.asOfDate, settings);
  const fallbackInvalidationPrice = round(Math.min(quote.low || quote.price, quote.previousClose || quote.price) * 0.99);
  const factorProfile = candidateFactorProfile(quote, sector || { name: quote.sector || '当前方向', heatScore: 0, rank: 999, news: [] }, mood);
  const plan = sector
    ? candidatePlan(quote, sector, factorProfile, session)
    : {
        action: '等待方向确认',
        actionTone: 'wait',
        entryCondition: '所属方向重新进入市场热度前十五，且收盘重新转强后再观察。',
        invalidation: `跌破 ${fallbackInvalidationPrice} 元时停止观察。`,
        invalidationPrice: fallbackInvalidationPrice,
        reasons: [
          `${quote.sector || '当前方向'}暂未形成有效的市场热度排名`,
          `当日涨幅 ${round(quote.changePercent)}%，换手 ${round(quote.turnoverRate)}%`,
          `近 60 日涨幅 ${round(quote.change60d)}%，成交额 ${round(quote.amount / 100_000_000, 1)} 亿`
        ]
      };
  const funding = buildFundingPlan(quote.price, plan.invalidationPrice, settings);
  const score = sector ? scoreCandidate(quote, sector, mood) : null;

  let decision = factorProfile.stage;
  let decisionTone = factorProfile.stage === '启动确认' ? 'watch' : 'wait';
  let summary = factorProfile.stage === '启动确认'
    ? '位置、趋势和量能形成初步配合，但仍需满足计划条件。'
    : '当前更适合加入观察名单，等待价格与量能进一步确认。';
  if (issues.length) {
    decision = '暂不考虑';
    decisionTone = 'exit';
    summary = `当前有 ${issues.length} 项不符合你的筛选条件，暂不列入计划。`;
  } else if (factorProfile.overheatReasons.length) {
    decision = '过热回避';
    decisionTone = 'board';
    summary = '短期位置或当日交易状态已经过热，不进入普通候选，先等待充分整理。';
  } else if (funding.quantity < 100) {
    decision = '资金条件不匹配';
    decisionTone = 'exit';
    summary = '按当前价格、失效价和资金上限无法安排 100 股，暂不列入计划。';
  } else if (quote.changePercent <= 0) {
    decision = '等待价格转强';
    decisionTone = 'wait';
    summary = '当前收盘表现尚未转强，先等待价格重新站稳后再评估。';
  } else if (!sector || sector.rank > 20) {
    decision = '等待方向转强';
    decisionTone = 'wait';
    summary = '个股虽有表现，但所属方向未进入市场热度前十五，暂不优先。';
  } else if (mood.score < 40) {
    decision = '等待市场转强';
    decisionTone = 'wait';
    summary = '整体市场温度偏低，即使个股较强也先降低主动出手意愿。';
  }

  return {
    version: 'single-stock-analysis-v2',
    generatedAt: new Date().toISOString(),
    asOfDate: snapshot.asOfDate,
    source: snapshot.source,
    stale: Boolean(snapshot.stale),
    fallbackReason: snapshot.fallbackReason || null,
    code: quote.code,
    name: quote.name,
    sector: quote.sector,
    price: round(quote.price),
    changePercent: round(quote.changePercent),
    turnoverRate: round(quote.turnoverRate),
    volumeRatio: round(quote.volumeRatio),
    amount: quote.amount,
    floatMarketValue: quote.floatMarketValue || quote.marketValue,
    marketValue: quote.marketValue,
    change60d: round(quote.change60d),
    changeYear: round(quote.changeYear),
    decision,
    decisionTone,
    summary,
    score,
    stage: factorProfile.stage,
    session,
    factorScores: factorProfile.factorScores,
    recentMetrics: factorProfile.recentMetrics,
    historyStatus: factorProfile.historyStatus,
    riskFlags: factorProfile.overheatReasons,
    gapPercent: factorProfile.gapPercent,
    amplitude: factorProfile.amplitude,
    closeLocation: factorProfile.closeLocation,
    sectorRank: sector?.rank || null,
    sectorHeat: sector?.heatScore || null,
    mood: { score: mood.score, label: mood.label, positionHint: mood.positionHint },
    personalFit: issues.length === 0 && factorProfile.overheatReasons.length === 0,
    issues,
    entryCondition: plan.entryCondition,
    invalidation: plan.invalidation,
    invalidationPrice: plan.invalidationPrice,
    reasons: plan.reasons,
    funding,
    news: sector?.news || []
  };
}

function parseMarketPayload(payload) {
  const rows = payload?.data?.diff;
  if (!Array.isArray(rows) || !rows.length) throw new Error('没有取得可用的全市场行情');
  const quotes = rows.map(normalizeQuote).filter((item) => item.code && item.quoteTime);
  const latestTimestamp = Math.max(...quotes.map((item) => item.quoteTime));
  return {
    asOfDate: formatShanghaiDate(latestTimestamp),
    fetchedAt: new Date().toISOString(),
    source: '公开市场行情与财经资讯',
    stale: false,
    quotes
  };
}

function radarSnapshotQuality(snapshot) {
  const quotes = Array.isArray(snapshot?.quotes) ? snapshot.quotes : [];
  const total = quotes.length;
  const pricedCount = quotes.filter((item) => Number(item.price) > 0 && Number(item.previousClose) > 0).length;
  const tradedCount = quotes.filter((item) => Number(item.amount) > 0).length;
  const minimumPricedCount = Math.max(1, Math.ceil(total * 0.6));
  const minimumTradedCount = Math.max(1, Math.ceil(total * 0.05));
  return {
    usable: total > 0 && pricedCount >= minimumPricedCount && tradedCount >= minimumTradedCount,
    total,
    pricedCount,
    tradedCount
  };
}

function resolveRadarSnapshot(freshSnapshot, freshNews = [], cached = null, failureReason = '') {
  const freshQuality = radarSnapshotQuality(freshSnapshot);
  if (freshQuality.usable) {
    return { snapshot: freshSnapshot, news: freshNews, shouldCache: true };
  }

  const reason = failureReason || (freshQuality.pricedCount === 0
    ? '最新行情价格尚未形成'
    : '最新行情成交数据尚未形成');
  const cachedQuality = radarSnapshotQuality(cached?.snapshot);
  if (cachedQuality.usable) {
    // 无效的新快照不能覆盖已验证数据；回退时保留真实数据日期，并把原因交给页面展示。
    return {
      snapshot: {
        ...cached.snapshot,
        stale: true,
        fallbackReason: `${reason}，已自动使用 ${cached.snapshot.asOfDate} 的最近有效数据`,
        fallbackAt: new Date().toISOString()
      },
      news: cached.news || [],
      shouldCache: false
    };
  }

  const error = new Error(`${reason}，且本机还没有可回退的有效快照`);
  error.statusCode = 503;
  throw error;
}

function parseNewsPayload(payload) {
  const rows = payload?.data?.list;
  if (!Array.isArray(rows)) return [];
  return rows.map((item) => ({
    id: String(item.code || ''),
    title: String(item.title || '').trim(),
    summary: String(item.summary || '').replace(/^【.+?】/, '').trim().slice(0, 180),
    publishedAt: String(item.showTime || ''),
    source: String(item.mediaName || '公开资讯'),
    url: String(item.uniqueUrl || item.url || '')
  })).filter((item) => item.title && /^https?:\/\//.test(item.url));
}

async function readRadarCache() {
  try {
    return JSON.parse(await fs.readFile(RADAR_CACHE_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeRadarCache(payload) {
  await fs.mkdir(path.dirname(RADAR_CACHE_FILE), { recursive: true });
  await fs.writeFile(RADAR_CACHE_FILE, JSON.stringify(payload), 'utf8');
}

async function fetchRadarSnapshot(inputSettings = DEFAULT_RADAR_SETTINGS) {
  NEWS_URL.searchParams.set('req_trace', `radar-${Date.now()}`);
  const [quoteResult, newsResult] = await Promise.allSettled([
    fetchAllMarketRows(),
    requestJson(NEWS_URL, 12_000)
  ]);
  const cached = await readRadarCache();
  if (quoteResult.status === 'fulfilled') {
    const snapshot = parseMarketPayload(quoteResult.value);
    const news = newsResult.status === 'fulfilled' ? parseNewsPayload(newsResult.value) : [];
    let resolved = resolveRadarSnapshot(snapshot, news, cached);
    const enrichedSnapshot = await enrichRadarCandidateHistory(resolved.snapshot, resolved.news, inputSettings);
    resolved = { ...resolved, snapshot: enrichedSnapshot };
    if (resolved.shouldCache) await writeRadarCache({ snapshot: resolved.snapshot, news: resolved.news });
    return { snapshot: resolved.snapshot, news: resolved.news };
  }
  const failureReason = `全市场行情更新失败：${quoteResult.reason?.message || '数据服务暂时不可用'}`;
  const resolved = resolveRadarSnapshot(null, [], cached, failureReason);
  const enrichedSnapshot = await enrichRadarCandidateHistory(resolved.snapshot, resolved.news, inputSettings);
  return { snapshot: enrichedSnapshot, news: resolved.news };
}

async function loadRadarSnapshot() {
  const cached = await readRadarCache();
  if (radarSnapshotQuality(cached?.snapshot).usable) return { snapshot: cached.snapshot, news: cached.news || [] };
  return fetchRadarSnapshot();
}

module.exports = {
  DEFAULT_RADAR_SETTINGS,
  RADAR_CACHE_FILE,
  analyzeStock,
  buildRadar,
  buildFundingPlan,
  enrichRadarSnapshotHistory,
  fetchRadarSnapshot,
  isEligibleQuote,
  loadRadarSnapshot,
  normalizeRadarSettings,
  parseMarketPayload,
  parseNewsPayload,
  radarSnapshotQuality,
  resolveRadarSnapshot,
  validateRadarSettings
};
