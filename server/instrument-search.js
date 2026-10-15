const https = require('https');

const SEARCH_HOST = 'searchapi.eastmoney.com';
const SEARCH_PATH = '/api/suggest/get';
const SEARCH_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8';
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function parseSearchPayload(payload) {
  const rows = payload?.QuotationCodeTable?.Data;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => (
      row.Classify === 'AStock' &&
      ['1', '2'].includes(String(row.MarketType)) &&
      /^\d{6}$/.test(String(row.Code || ''))
    ))
    .map((row) => ({
      id: String(row.Code),
      name: String(row.Name || row.Code),
      market: String(row.MarketType) === '1' ? 'SH' : 'SZ'
    }));
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        Accept: 'application/json,text/plain,*/*',
        Referer: 'https://quote.eastmoney.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`名称搜索服务返回 ${response.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 1024 * 1024) chunks.push(chunk);
      });
      response.on('end', () => {
        if (size > 1024 * 1024) {
          reject(new Error('名称搜索结果过大'));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(new Error('名称搜索结果格式不正确'));
        }
      });
    });
    request.setTimeout(8000, () => request.destroy(new Error('名称搜索等待时间过长')));
    request.on('error', reject);
  });
}

function findLocal(query, assets) {
  const keyword = query.toLocaleLowerCase('zh-CN');
  return assets
    .filter((asset) => asset.id.includes(keyword) || asset.name.toLocaleLowerCase('zh-CN').includes(keyword))
    .map(({ id, name, market }) => ({ id, name, market }))
    .slice(0, 12);
}

async function searchInstruments(query, localAssets = []) {
  const keyword = String(query || '').trim().slice(0, 32);
  if (!keyword) return [];

  const localItems = findLocal(keyword, localAssets);
  const cacheKey = keyword.toLocaleLowerCase('zh-CN');
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.items;

  const url = new URL(`https://${SEARCH_HOST}${SEARCH_PATH}`);
  url.searchParams.set('input', keyword);
  url.searchParams.set('type', '14');
  url.searchParams.set('token', SEARCH_TOKEN);
  url.searchParams.set('count', '20');

  try {
    const remoteItems = parseSearchPayload(await requestJson(url));
    const merged = [...localItems, ...remoteItems]
      .filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index)
      .slice(0, 12);
    cache.set(cacheKey, { items: merged, expiresAt: Date.now() + CACHE_TTL_MS });
    if (cache.size > 100) cache.delete(cache.keys().next().value);
    return merged;
  } catch (error) {
    if (localItems.length) return localItems;
    const wrapped = new Error('名称搜索暂时不可用，请直接输入六位代码');
    wrapped.statusCode = 502;
    throw wrapped;
  }
}

module.exports = {
  parseSearchPayload,
  searchInstruments
};
