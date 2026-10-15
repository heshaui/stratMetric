const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { createHash } = require('crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
const MARKET_DIR = path.join(ROOT_DIR, 'data', 'market');
const MARKET_FILE = path.join(MARKET_DIR, 'real-daily-v1.json');
const FETCH_SCRIPT = path.join(ROOT_DIR, 'scripts', 'fetch_market_data.py');
const DEFAULT_CODES = ['600000', '600036', '600519', '601318', '601899', '000001', '000333', '000651', '000858', '002594', '300750', '300760'];

function pythonCandidates() {
  const candidates = [];
  if (process.env.STRATMETRIC_PYTHON) candidates.push(process.env.STRATMETRIC_PYTHON);
  candidates.push(path.join(ROOT_DIR, '.venv', 'Scripts', 'python.exe'));
  candidates.push('python3');
  candidates.push('python');
  return candidates;
}

function runPython(candidate, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(candidate, args, {
      cwd: ROOT_DIR,
      env: { ...process.env, PYTHONUTF8: '1' },
      windowsHide: true
    });
    let output = '';
    let errorOutput = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(errorOutput.trim() || output.trim() || `数据更新进程返回 ${code}`));
    });
  });
}

async function syncMarketData(codes = DEFAULT_CODES) {
  const normalizedCodes = [...new Set(codes.map((code) => String(code).trim()))];
  if (!normalizedCodes.length || normalizedCodes.length > 40 || normalizedCodes.some((code) => !/^\d{6}$/.test(code))) {
    const error = new Error('证券代码必须是 1 至 40 个六位数字');
    error.statusCode = 400;
    throw error;
  }
  await fs.mkdir(MARKET_DIR, { recursive: true });
  const args = [FETCH_SCRIPT, '--codes', normalizedCodes.join(','), '--start', '2022-01-01', '--end', '2050-01-01', '--output', MARKET_FILE];
  let lastError = null;
  for (const candidate of pythonCandidates()) {
    try {
      await runPython(candidate, args);
      return loadRealDataset();
    } catch (error) {
      lastError = error;
      if (!['ENOENT', 'UNKNOWN'].includes(error.code)) break;
    }
  }
  const wrapped = new Error(`真实数据更新失败：${lastError ? lastError.message : '没有可用的 Python 运行环境'}`);
  wrapped.statusCode = 502;
  throw wrapped;
}

function normalizeRealDataset(payload) {
  const assets = payload.assets;
  const rawSeries = payload.series;
  const firstDates = assets.map((asset) => rawSeries[asset.id][0].date);
  const lastDates = assets.map((asset) => rawSeries[asset.id][rawSeries[asset.id].length - 1].date);
  const startDate = firstDates.sort().at(-1);
  const endDate = lastDates.sort()[0];
  const allDates = new Set();
  assets.forEach((asset) => rawSeries[asset.id].forEach((row) => {
    if (row.date >= startDate && row.date <= endDate) allDates.add(row.date);
  }));
  const dates = [...allDates].sort();
  const series = {};

  assets.forEach((asset) => {
    const rowsByDate = new Map(rawSeries[asset.id].map((row) => [row.date, row]));
    let previous = null;
    series[asset.id] = dates.map((date) => {
      const current = rowsByDate.get(date);
      if (current) {
        previous = current;
        return current;
      }
      if (!previous) return null;
      return { ...previous, date, open: previous.close, high: previous.close, low: previous.close, amount: 0, volume: 0, turn: 0, tradable: false };
    });
  });

  // 同一交易日可能更新为不同证券范围，内容指纹可避免旧结果被误认为当前数据的结果。
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({
      assets: assets.map(({ id, name, market }) => ({ id, name, market })),
      series: assets.map((asset) => rawSeries[asset.id])
    }))
    .digest('hex')
    .slice(0, 8);
  const datasetId = `real-daily-${endDate.replace(/-/g, '')}-${fingerprint}`;

  return {
    metadata: { ...payload.metadata, id: datasetId, startDate, endDate, researchStartDate: startDate, instrumentCount: assets.length },
    assets,
    dates,
    series
  };
}

async function loadRealDataset() {
  try {
    const raw = await fs.readFile(MARKET_FILE, 'utf8');
    return normalizeRealDataset(JSON.parse(raw));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

module.exports = {
  DEFAULT_CODES,
  MARKET_FILE,
  normalizeRealDataset,
  loadRealDataset,
  syncMarketData
};
