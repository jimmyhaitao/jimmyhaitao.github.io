/**
 * Crypto Portfolio Dashboard — Backend API
 *
 * Aggregates balances from CEXs (Coinbase, OKX),
 * DEXs (Hyperliquid, PancakeSwap on Monad), DeFi (Kamino),
 * and wallets (Metamask, Phantom).
 * Supports manual holdings for geo-blocked or unsupported platforms.
 *
 * Usage:
 *   1. Copy .env.example to .env and fill in your credentials
 *   2. npm install
 *   3. npm start
 */
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const { fetchCoinbaseBalances, fetchOKXBalances, testCoinbaseAuth } = require("./services/cex");
const { fetchHyperliquidBalances } = require("./services/hyperliquid");
const { fetchPhantomBalances, fetchKaminoBalances } = require("./services/solana");
const { fetchMetamaskBalances, fetchPancakeSwapBalances } = require("./services/evm");
const { fetchPrices } = require("./services/prices");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ─── Classification ─────────────────────────────────────────────
const MAJOR_COINS = ["BTC", "ETH", "SOL", "XRP"];
const STABLECOINS = ["USDT", "USDC", "DAI", "BUSD", "TUSD", "FRAX"];

function classifyCoin(symbol) {
  const s = symbol.toUpperCase();
  if (MAJOR_COINS.includes(s)) return "Major";
  if (STABLECOINS.includes(s)) return "Stablecoin";
  return "Altcoin";
}

// ─── Safe number helpers ────────────────────────────────────────
function safeNum(v) {
  const n = Number(v);
  return isNaN(n) || !isFinite(n) ? 0 : n;
}

function fmtAmount(amount) {
  const a = safeNum(amount);
  if (a === 0) return "0";
  if (a >= 1e6) return (a / 1e6).toFixed(2) + "M";
  if (a >= 1000) return a.toFixed(2);
  if (a >= 1) return a.toFixed(4);
  if (a >= 0.0001) return a.toFixed(6);
  return a.toFixed(8);
}

function fmtUSD(v) {
  const n = safeNum(v);
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtPrice(p) {
  const n = safeNum(p);
  if (n === 0) return '<span class="muted">N/A</span>';
  if (n >= 1) return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(8)}`;
}

// ─── Manual Holdings ────────────────────────────────────────────
// Load from manual-holdings.json — allows adding balances for
// geo-blocked or otherwise inaccessible platforms
const MANUAL_HOLDINGS_FILE = path.join(__dirname, "manual-holdings.json");

function loadManualHoldings() {
  try {
    if (fs.existsSync(MANUAL_HOLDINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(MANUAL_HOLDINGS_FILE, "utf8"));
      console.log("[Manual] Loaded manual holdings:", JSON.stringify(data));
      return data; // { "PlatformName": [{ coin, amount }, ...] }
    }
  } catch (e) {
    console.warn("[Manual] Could not load manual-holdings.json:", e.message);
  }
  return {};
}

function saveManualHoldings(data) {
  fs.writeFileSync(MANUAL_HOLDINGS_FILE, JSON.stringify(data, null, 2));
  console.log("[Manual] Saved manual holdings");
}

// Initialize default if file doesn't exist
if (!fs.existsSync(MANUAL_HOLDINGS_FILE)) {
  saveManualHoldings({});
}

// ─── Fetch all balances ─────────────────────────────────────────
const PLATFORM_FETCHERS = {
  Coinbase: fetchCoinbaseBalances,
  OKX: fetchOKXBalances,
  Hyperliquid: fetchHyperliquidBalances,
  Kamino: fetchKaminoBalances,
  PancakeSwap: fetchPancakeSwapBalances,
  Metamask: fetchMetamaskBalances,
  Phantom: fetchPhantomBalances,
};

async function fetchAllBalances() {
  console.log("\n─── Fetching all balances ───");
  const start = Date.now();

  const platformNames = Object.keys(PLATFORM_FETCHERS);
  const results = await Promise.allSettled(
    platformNames.map((name) => PLATFORM_FETCHERS[name]())
  );

  const portfolio = {};
  const platformStatus = {};

  for (let i = 0; i < platformNames.length; i++) {
    const name = platformNames[i];
    const result = results[i];

    if (result.status === "fulfilled") {
      portfolio[name] = result.value || [];
      platformStatus[name] = {
        status: result.value.length > 0 ? "ok" : "empty",
        assets: result.value.length,
        error: null,
      };
    } else {
      portfolio[name] = [];
      platformStatus[name] = {
        status: "error",
        assets: 0,
        error: result.reason?.message || "Unknown error",
      };
      console.error(`[${name}] Failed:`, result.reason?.message);
    }
  }

  // Merge manual holdings — skip manual entries whose automated counterpart returned data.
  // E.g. "Kamino (Manual)" is skipped if "Kamino" already has results.
  const manual = loadManualHoldings();
  for (const [platform, holdings] of Object.entries(manual)) {
    if (!Array.isArray(holdings) || holdings.length === 0) continue;

    // Check if there's a matching automated platform with data
    const baseName = platform.replace(/\s*\(Manual\)\s*$/, "");
    const autoData = portfolio[baseName];
    if (autoData && autoData.length > 0) {
      console.log(`[Manual] Skipping "${platform}" — automated "${baseName}" returned ${autoData.length} asset(s)`);
      continue;
    }

    portfolio[platform] = holdings;
    platformStatus[platform] = {
      status: "ok",
      assets: holdings.length,
      error: null,
      manual: true,
    };
  }

  const elapsed = Date.now() - start;
  const totalAssets = Object.values(portfolio).reduce((s, h) => s + h.length, 0);
  const activeCount = Object.values(platformStatus).filter((s) => s.status === "ok").length;
  console.log(`─── Done: ${totalAssets} assets from ${activeCount} active platforms (${elapsed}ms) ───\n`);

  return { portfolio, platformStatus };
}

// Track platform status separately
let lastPlatformStatus = {};

// ─── Cache ──────────────────────────────────────────────────────
let portfolioCache = null;
let cacheTime = 0;
let refreshInProgress = false;
const BALANCE_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

async function getCachedPortfolio(forceRefresh = false) {
  const now = Date.now();
  const cacheExpired = !portfolioCache || now - cacheTime >= BALANCE_CACHE_TTL;

  // If cache is fresh, return it
  if (!forceRefresh && !cacheExpired) {
    return { portfolio: portfolioCache, platformStatus: lastPlatformStatus };
  }

  // If we have stale cache and a refresh is already running, return stale
  if (portfolioCache && refreshInProgress) {
    return { portfolio: portfolioCache, platformStatus: lastPlatformStatus };
  }

  // If we have stale cache, return it immediately and refresh in background
  if (portfolioCache && !forceRefresh) {
    if (!refreshInProgress) {
      refreshInProgress = true;
      fetchAllBalances().then(({ portfolio, platformStatus }) => {
        portfolioCache = portfolio;
        lastPlatformStatus = platformStatus;
        cacheTime = Date.now();
      }).catch(err => {
        console.error("[Cache] Background refresh failed:", err.message);
      }).finally(() => {
        refreshInProgress = false;
      });
    }
    return { portfolio: portfolioCache, platformStatus: lastPlatformStatus };
  }

  // No cache at all or force refresh — must wait
  refreshInProgress = true;
  try {
    const { portfolio, platformStatus } = await fetchAllBalances();
    portfolioCache = portfolio;
    lastPlatformStatus = platformStatus;
    cacheTime = now;
    return { portfolio, platformStatus };
  } finally {
    refreshInProgress = false;
  }
}

// ─── Platform config status ─────────────────────────────────────
function getConfigStatus() {
  return {
    Coinbase: !!(process.env.COINBASE_API_KEY && process.env.COINBASE_API_KEY !== "your_coinbase_api_key"),
    OKX: !!(process.env.OKX_API_KEY && process.env.OKX_API_KEY !== "your_okx_api_key"),
    Hyperliquid: !!(process.env.HYPERLIQUID_ADDRESS && process.env.HYPERLIQUID_ADDRESS !== "0xYourHyperliquidAddress"),
    Kamino: !!(process.env.SOLANA_ADDRESS && process.env.SOLANA_ADDRESS !== "YourSolanaPublicKey"),
    PancakeSwap: !!(process.env.BSC_ADDRESS || process.env.ETH_ADDRESS),
    Metamask: !!(process.env.ETH_ADDRESS && process.env.ETH_ADDRESS !== "0xYourEthereumAddress"),
    Phantom: !!(process.env.SOLANA_ADDRESS && process.env.SOLANA_ADDRESS !== "YourSolanaPublicKey"),
  };
}

const TOTAL_PLATFORMS = 7; // Coinbase, OKX, Hyperliquid, Kamino, PancakeSwap, Metamask, Phantom

// ─── Shared CSS ─────────────────────────────────────────────────
const SHARED_CSS = `
  body { font-family: -apple-system, sans-serif; background: #0a0a1a; color: #e0e0e0; padding: 30px; margin: 0; }
  h1 { background: linear-gradient(90deg, #F7931A, #627EEA, #9945FF); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 4px; }
  .sub { color: #888; font-size: 13px; margin-bottom: 24px; }
  .cards { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
  .card { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 16px 20px; flex: 1; min-width: 150px; }
  .card-label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .card-value { font-size: 24px; font-weight: 700; color: #fff; }
  .card-sub { font-size: 12px; color: #888; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  th { text-align: left; font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.1); cursor: pointer; user-select: none; }
  th:hover { color: #fff; }
  th.sorted-asc::after { content: " ▲"; color: #627EEA; }
  th.sorted-desc::after { content: " ▼"; color: #627EEA; }
  td { padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 13px; }
  tr:hover { background: rgba(255,255,255,0.02); }
  .num { text-align: right; font-family: 'SF Mono', Menlo, monospace; }
  .muted { color: #666; font-size: 12px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .dot-ok { background: #2ECC71; } .dot-warn { background: #F1C40F; } .dot-err { background: #E74C3C; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; }
  .badge-manual { background: rgba(98,126,234,0.2); color: #627EEA; }
  .green { color: #2ECC71; } .red { color: #E74C3C; }
  h2 { font-size: 16px; color: #ccc; margin-top: 32px; margin-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 8px; }
  .links { margin-top: 24px; font-size: 13px; }
  .links a { color: #627EEA; margin-right: 16px; }
  .filter-bar { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; font-size: 13px; }
  .filter-bar label { color: #888; }
  .filter-bar input, .filter-bar select { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: #fff; padding: 6px 10px; border-radius: 6px; font-size: 13px; }
  .filter-bar input:focus, .filter-bar select:focus { outline: none; border-color: #627EEA; }
  pre { background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 12px; color: #ccc; }
  nav { margin-bottom: 24px; }
  nav a { color: #627EEA; margin-right: 16px; font-size: 13px; }
`;

// ─── Navigation bar ─────────────────────────────────────────────
const NAV_HTML = `<nav>
  <a href="/">Home</a>
  <a href="/api/portfolio">Portfolio</a>
  <a href="/api/portfolio/balances">Balances</a>
  <a href="/api/prices">Prices</a>
  <a href="/api/health">Health</a>
  <a href="/api/status">Status</a>
  <a href="/api/manual">Manual Holdings</a>
  <a href="/api/test-coinbase">Test Coinbase</a>
</nav>`;

// ─── Sortable table JavaScript ──────────────────────────────────
const SORT_FILTER_JS = `
<script>
function setupTable(tableId) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const headers = table.querySelectorAll('th[data-sort]');
  let currentSort = null;
  let currentDir = 'desc';

  headers.forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      const type = th.dataset.type || 'string';
      if (currentSort === col) {
        currentDir = currentDir === 'desc' ? 'asc' : 'desc';
      } else {
        currentSort = col;
        currentDir = 'desc';
      }
      headers.forEach(h => h.classList.remove('sorted-asc', 'sorted-desc'));
      th.classList.add('sorted-' + currentDir);
      sortTable(table, parseInt(th.dataset.colIdx), type, currentDir);
    });
  });
}

function sortTable(table, colIdx, type, dir) {
  const tbody = table.querySelector('tbody');
  const rows = Array.from(tbody.rows);
  rows.sort((a, b) => {
    let va = a.cells[colIdx]?.textContent.trim() || '';
    let vb = b.cells[colIdx]?.textContent.trim() || '';
    if (type === 'number') {
      va = parseFloat(va.replace(/[$,%NAN/a]/gi, '')) || 0;
      vb = parseFloat(vb.replace(/[$,%NAN/a]/gi, '')) || 0;
    }
    if (dir === 'asc') return va > vb ? 1 : va < vb ? -1 : 0;
    return va < vb ? 1 : va > vb ? -1 : 0;
  });
  rows.forEach(r => tbody.appendChild(r));
}

function parseUSD(text) {
  text = (text || '').trim();
  if (text.includes('M')) return parseFloat(text.replace(/[$,M]/g, '')) * 1e6;
  if (text.includes('K')) return parseFloat(text.replace(/[$,K]/g, '')) * 1e3;
  return parseFloat(text.replace(/[$,]/g, '')) || 0;
}

function applyFilters() {
  const minVal   = parseFloat(document.getElementById('min-notional')?.value) || 0;
  const platform = (document.getElementById('filter-platform')?.value || '').toLowerCase();
  const asset    = (document.getElementById('filter-asset')?.value || '').toLowerCase().trim();
  const category = (document.getElementById('filter-category')?.value || '').toLowerCase();

  const table = document.getElementById('holdings-table');
  if (!table) return;
  const rows = table.querySelectorAll('tbody tr');
  let visible = 0;

  rows.forEach(row => {
    const cells = row.cells;
    if (!cells || cells.length < 7) return;

    const rowPlatform  = cells[0].textContent.toLowerCase();
    const rowAsset     = cells[1].textContent.toLowerCase();
    const rowCategory  = cells[2].textContent.toLowerCase();
    const rowValue     = parseUSD(cells[6].textContent);

    const matchPlatform  = !platform || rowPlatform.includes(platform);
    const matchAsset     = !asset    || rowAsset.includes(asset);
    const matchCategory  = !category || rowCategory.includes(category);
    const matchNotional  = rowValue >= minVal;

    if (matchPlatform && matchAsset && matchCategory && matchNotional) {
      row.style.display = '';
      visible++;
    } else {
      row.style.display = 'none';
    }
  });

  const countEl = document.getElementById('visible-count');
  if (countEl) countEl.textContent = visible;
}

document.addEventListener('DOMContentLoaded', () => {
  setupTable('holdings-table');
  setupTable('platform-table');

  // Attach all filter inputs to the shared applyFilters function
  ['min-notional', 'filter-platform', 'filter-asset', 'filter-category'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', applyFilters);
  });

  // Run once on load to apply the default $100 notional filter
  applyFilters();
});
</script>
`;

// ─── HTML Renderers ─────────────────────────────────────────────

function renderPortfolioHtml(data) {
  const { portfolio, summary, platformStatus, meta } = data;
  const { totalValue, byCategory, byExchange } = summary;

  const statusDot = (s) => s === "ok" ? '<span class="dot dot-ok"></span>' : s === "empty" ? '<span class="dot dot-warn"></span>' : '<span class="dot dot-err"></span>';
  const catColor = (c) => c === "Major" ? "#F7931A" : c === "Stablecoin" ? "#2ECC71" : "#E74C3C";

  // Build platform rows
  const platformRows = Object.entries(byExchange)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, info]) => {
      const ps = platformStatus[name] || {};
      const pct = totalValue > 0 ? ((info.total / totalValue) * 100).toFixed(1) : "0.0";
      const manualBadge = ps.manual ? ' <span class="badge badge-manual">manual</span>' : '';
      return `<tr>
        <td>${statusDot(ps.status)} ${name}${manualBadge}</td>
        <td>${ps.assets || info.count} assets</td>
        <td class="num">${fmtUSD(info.total)}</td>
        <td class="num">${pct}%</td>
        <td class="muted">${ps.error || (ps.status === "empty" ? "No data returned" : "OK")}</td>
      </tr>`;
    }).join("");

  // Build all holdings rows sorted by value
  const allHoldings = [];
  for (const [exchange, holdings] of Object.entries(portfolio)) {
    for (const h of holdings) {
      allHoldings.push({ ...h, exchange });
    }
  }
  allHoldings.sort((a, b) => safeNum(b.value) - safeNum(a.value));

  // ── Pie chart data: aggregate by coin symbol, top N + "Other" ──
  const byCoin = {};
  for (const h of allHoldings) {
    const sym = h.coin || "?";
    byCoin[sym] = (byCoin[sym] || 0) + safeNum(h.value);
  }
  const sortedCoins = Object.entries(byCoin).sort((a, b) => b[1] - a[1]);
  const PIE_SLICES = 10;
  const pieData = [];
  let otherTotal = 0;
  for (let i = 0; i < sortedCoins.length; i++) {
    if (i < PIE_SLICES) {
      pieData.push({ label: sortedCoins[i][0], value: sortedCoins[i][1] });
    } else {
      otherTotal += sortedCoins[i][1];
    }
  }
  if (otherTotal > 0) pieData.push({ label: "Other", value: otherTotal });

  const PIE_COLORS = ["#F7931A","#627EEA","#2ECC71","#E74C3C","#9B59B6","#3498DB","#F39C12","#1ABC9C","#E67E22","#8E44AD","#7F8C8D"];
  const pieTotal = pieData.reduce((s, d) => s + d.value, 0);
  let pieSlicesHtml = "";
  let pieLegendHtml = "";
  let cumPct = 0;
  for (let i = 0; i < pieData.length; i++) {
    const pct = pieTotal > 0 ? (pieData[i].value / pieTotal) : 0;
    const color = PIE_COLORS[i % PIE_COLORS.length];
    // SVG arc using conic-gradient simulation via stroke-dasharray on circles
    const startAngle = cumPct * 360;
    const sliceAngle = pct * 360;
    cumPct += pct;
    // For the legend
    pieLegendHtml += `<div style="display:flex;align-items:center;gap:6px;padding:3px 0">
      <span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${color};flex-shrink:0"></span>
      <span style="color:#ccc;font-size:13px">${pieData[i].label}</span>
      <span style="color:#888;font-size:12px;margin-left:auto">${fmtUSD(pieData[i].value)} (${(pct*100).toFixed(1)}%)</span>
    </div>`;
  }
  // Build conic-gradient CSS for a pure-CSS pie chart (more reliable than SVG arcs)
  let conicStops = [];
  cumPct = 0;
  for (let i = 0; i < pieData.length; i++) {
    const pct = pieTotal > 0 ? (pieData[i].value / pieTotal) : 0;
    const color = PIE_COLORS[i % PIE_COLORS.length];
    const startDeg = (cumPct * 360).toFixed(2);
    cumPct += pct;
    const endDeg = (cumPct * 360).toFixed(2);
    conicStops.push(`${color} ${startDeg}deg ${endDeg}deg`);
  }
  const pieChartCss = `background: conic-gradient(${conicStops.join(", ")});`;

  const holdingRows = allHoldings.map(h => {
    const price = safeNum(h.price);
    const value = safeNum(h.value);
    const change = h.change24h && isFinite(h.change24h) ? `<span class="${h.change24h >= 0 ? 'green' : 'red'}">${h.change24h >= 0 ? '+' : ''}${h.change24h.toFixed(1)}%</span>` : '-';
    return `<tr>
      <td>${h.exchange}</td>
      <td><strong>${h.coin}</strong></td>
      <td><span class="badge" style="background:${catColor(h.category)}22;color:${catColor(h.category)}">${h.category}</span></td>
      <td class="num">${fmtAmount(h.amount)}</td>
      <td class="num">${fmtPrice(price)}</td>
      <td class="num">${change}</td>
      <td class="num"><strong>${fmtUSD(value)}</strong></td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html>
<head>
  <title>Portfolio — Crypto Dashboard</title>
  <style>${SHARED_CSS}</style>
</head>
<body>
  ${NAV_HTML}
  <h1>Crypto Portfolio</h1>
  <div class="sub">Updated ${new Date(meta.timestamp).toLocaleString()} &middot; Cache age: ${Math.round(safeNum(meta.cacheAge) / 1000)}s &middot; <a href="/api/portfolio?refresh=true" style="color:#627EEA">Force refresh</a> &middot; <a href="/api/portfolio?format=json" style="color:#627EEA">JSON</a></div>

  <div class="cards">
    <div class="card">
      <div class="card-label">Total Value</div>
      <div class="card-value">${fmtUSD(totalValue)}</div>
    </div>
    <div class="card">
      <div class="card-label">Major (BTC/ETH/SOL/XRP)</div>
      <div class="card-value" style="color:#F7931A">${fmtUSD(byCategory.Major)}</div>
      <div class="card-sub">${totalValue > 0 ? ((safeNum(byCategory.Major)/totalValue)*100).toFixed(1) : 0}%</div>
    </div>
    <div class="card">
      <div class="card-label">Stablecoins</div>
      <div class="card-value" style="color:#2ECC71">${fmtUSD(byCategory.Stablecoin)}</div>
      <div class="card-sub">${totalValue > 0 ? ((safeNum(byCategory.Stablecoin)/totalValue)*100).toFixed(1) : 0}%</div>
    </div>
    <div class="card">
      <div class="card-label">Altcoins</div>
      <div class="card-value" style="color:#E74C3C">${fmtUSD(byCategory.Altcoin)}</div>
      <div class="card-sub">${totalValue > 0 ? ((safeNum(byCategory.Altcoin)/totalValue)*100).toFixed(1) : 0}%</div>
    </div>
  </div>

  <h2>Allocation by Coin</h2>
  <div style="display:flex;gap:32px;align-items:flex-start;flex-wrap:wrap;margin-bottom:24px">
    <div style="width:220px;height:220px;border-radius:50%;${pieChartCss};flex-shrink:0;box-shadow:0 0 20px rgba(0,0,0,0.3)"></div>
    <div style="flex:1;min-width:220px;max-width:400px">${pieLegendHtml}</div>
  </div>

  <h2>Platform Status</h2>
  <table id="platform-table">
    <thead><tr>
      <th data-sort="platform" data-col-idx="0">Platform</th>
      <th data-sort="assets" data-col-idx="1" data-type="number">Assets</th>
      <th data-sort="value" data-col-idx="2" data-type="number" class="num">Value</th>
      <th data-sort="pct" data-col-idx="3" data-type="number" class="num">% Portfolio</th>
      <th>Status</th>
    </tr></thead>
    <tbody>${platformRows}</tbody>
  </table>

  <h2>Holdings (<span id="visible-count">${allHoldings.length}</span> of ${allHoldings.length})</h2>
  <div class="filter-bar">
    <label>Min $</label>
    <input type="number" id="min-notional" placeholder="100" min="0" step="1" value="100" style="width:80px">
    <label>Platform</label>
    <select id="filter-platform">
      <option value="">All</option>
      ${[...new Set(allHoldings.map(h => h.exchange))].sort().map(p => `<option value="${p.toLowerCase()}">${p}</option>`).join("")}
    </select>
    <label>Asset</label>
    <input type="text" id="filter-asset" placeholder="e.g. BTC" style="width:90px">
    <label>Category</label>
    <select id="filter-category">
      <option value="">All</option>
      <option value="major">Major</option>
      <option value="stablecoin">Stablecoin</option>
      <option value="altcoin">Altcoin</option>
    </select>
  </div>
  <table id="holdings-table">
    <thead><tr>
      <th data-sort="platform" data-col-idx="0">Platform</th>
      <th data-sort="asset" data-col-idx="1">Asset</th>
      <th data-sort="category" data-col-idx="2">Category</th>
      <th data-sort="amount" data-col-idx="3" data-type="number" class="num">Amount</th>
      <th data-sort="price" data-col-idx="4" data-type="number" class="num">Price</th>
      <th data-sort="change" data-col-idx="5" data-type="number" class="num">24h</th>
      <th data-sort="value" data-col-idx="6" data-type="number" class="num sorted-desc">Value</th>
    </tr></thead>
    <tbody>${holdingRows}</tbody>
  </table>

  ${SORT_FILTER_JS}
</body>
</html>`;
}

function renderBalancesHtml(data) {
  const { portfolio, platformStatus, timestamp } = data;

  let rows = "";
  for (const [platform, holdings] of Object.entries(portfolio)) {
    const ps = platformStatus[platform] || {};
    if (holdings.length === 0) {
      rows += `<tr><td>${platform}</td><td colspan="2" class="muted">${ps.error || "No holdings"}</td></tr>`;
    } else {
      for (const h of holdings) {
        rows += `<tr><td>${platform}</td><td><strong>${h.coin}</strong></td><td class="num">${fmtAmount(h.amount)}</td></tr>`;
      }
    }
  }

  return `<!DOCTYPE html>
<html><head><title>Balances — Crypto Dashboard</title><style>${SHARED_CSS}</style></head>
<body>
  ${NAV_HTML}
  <h1>Raw Balances</h1>
  <div class="sub">As of ${new Date(timestamp).toLocaleString()} &middot; <a href="/api/portfolio/balances?format=json" style="color:#627EEA">JSON</a></div>
  <table>
    <thead><tr><th>Platform</th><th>Coin</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body></html>`;
}

function renderPricesHtml(data) {
  const { prices, timestamp } = data;

  const rows = Object.entries(prices)
    .sort((a, b) => safeNum(b[1].usd) - safeNum(a[1].usd))
    .map(([symbol, info]) => {
      const change = info.change24h && isFinite(info.change24h)
        ? `<span class="${info.change24h >= 0 ? 'green' : 'red'}">${info.change24h >= 0 ? '+' : ''}${info.change24h.toFixed(2)}%</span>`
        : '-';
      return `<tr>
        <td><strong>${symbol}</strong></td>
        <td><span class="badge" style="background:${classifyCoin(symbol) === 'Major' ? '#F7931A22' : classifyCoin(symbol) === 'Stablecoin' ? '#2ECC7122' : '#E74C3C22'};color:${classifyCoin(symbol) === 'Major' ? '#F7931A' : classifyCoin(symbol) === 'Stablecoin' ? '#2ECC71' : '#E74C3C'}">${classifyCoin(symbol)}</span></td>
        <td class="num">${fmtPrice(info.usd)}</td>
        <td class="num">${change}</td>
      </tr>`;
    }).join("");

  return `<!DOCTYPE html>
<html><head><title>Prices — Crypto Dashboard</title><style>${SHARED_CSS}</style></head>
<body>
  ${NAV_HTML}
  <h1>Current Prices</h1>
  <div class="sub">As of ${new Date(timestamp).toLocaleString()} &middot; ${Object.keys(prices).length} coins &middot; <a href="/api/prices?format=json" style="color:#627EEA">JSON</a></div>
  <table id="holdings-table">
    <thead><tr>
      <th data-sort="symbol" data-col-idx="0">Coin</th>
      <th data-sort="cat" data-col-idx="1">Category</th>
      <th data-sort="price" data-col-idx="2" data-type="number" class="num">Price (USD)</th>
      <th data-sort="change" data-col-idx="3" data-type="number" class="num">24h Change</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${SORT_FILTER_JS}
</body></html>`;
}

function renderHealthHtml(data) {
  const rows = Object.entries(data.configuredPlatforms)
    .map(([name, ok]) => `<tr><td>${name}</td><td>${ok ? '<span class="green">✓</span>' : '<span class="red">✗</span>'}</td></tr>`)
    .join("");

  return `<!DOCTYPE html>
<html><head><title>Health — Crypto Dashboard</title><style>${SHARED_CSS}</style></head>
<body>
  ${NAV_HTML}
  <h1>Server Health</h1>
  <div class="cards">
    <div class="card"><div class="card-label">Status</div><div class="card-value green">${data.status.toUpperCase()}</div></div>
    <div class="card"><div class="card-label">Uptime</div><div class="card-value">${(data.uptime / 60).toFixed(1)} min</div></div>
    <div class="card"><div class="card-label">Cache Age</div><div class="card-value">${data.cacheAge ? Math.round(data.cacheAge / 1000) + 's' : 'N/A'}</div></div>
  </div>
  <h2>Platform Configuration</h2>
  <table><thead><tr><th>Platform</th><th>Configured</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="sub"><a href="/api/health?format=json" style="color:#627EEA">JSON</a></div>
</body></html>`;
}

function renderStatusHtml(data) {
  const rows = Object.entries(data.platforms)
    .map(([name, ok]) => `<tr><td>${name}</td><td>${ok ? '<span class="green">Configured</span>' : '<span class="muted">Not configured</span>'}</td></tr>`)
    .join("");

  return `<!DOCTYPE html>
<html><head><title>Status — Crypto Dashboard</title><style>${SHARED_CSS}</style></head>
<body>
  ${NAV_HTML}
  <h1>Configuration Status</h1>
  <div class="sub">${data.configuredCount}/${data.totalPlatforms} platforms configured &middot; <a href="/api/status?format=json" style="color:#627EEA">JSON</a></div>
  <table><thead><tr><th>Platform</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
}

function renderManualHtml(manual) {
  let rows = "";
  for (const [platform, holdings] of Object.entries(manual)) {
    for (const h of holdings) {
      rows += `<tr><td>${platform}</td><td><strong>${h.coin}</strong></td><td class="num">${fmtAmount(h.amount)}</td></tr>`;
    }
  }
  if (!rows) {
    rows = `<tr><td colspan="3" class="muted">No manual holdings configured</td></tr>`;
  }

  return `<!DOCTYPE html>
<html><head><title>Manual Holdings — Crypto Dashboard</title><style>${SHARED_CSS}</style></head>
<body>
  ${NAV_HTML}
  <h1>Manual Holdings</h1>
  <div class="sub">For geo-blocked or inaccessible platforms &middot; <a href="/api/manual?format=json" style="color:#627EEA">JSON</a></div>

  <table>
    <thead><tr><th>Platform</th><th>Coin</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="card" style="max-width:600px; margin-top: 24px;">
    <h3 style="margin-top:0">Edit Manual Holdings</h3>
    <p style="font-size:13px; color:#888;">
      Edit <code>manual-holdings.json</code> in the backend folder, then restart or force refresh.<br><br>
      Format:
    </p>
    <pre>{
  "Cold Wallet": [
    { "coin": "BTC", "amount": 0.5 },
    { "coin": "ETH", "amount": 2.0 }
  ],
  "Other Platform": [
    { "coin": "USDT", "amount": 5000 }
  ]
}</pre>
    <p style="font-size:13px; color:#888;">
      Or use the API: <code>POST /api/manual</code> with the same JSON body.
    </p>
  </div>
</body></html>`;
}

// ─── Helper: respond as HTML or JSON ────────────────────────────
function respond(req, res, jsonData, htmlRenderer) {
  if (req.query.format === "json") {
    return res.json(jsonData);
  }
  return res.send(htmlRenderer(jsonData));
}

// ─── API Routes ─────────────────────────────────────────────────

// Root route — status page
app.get("/", (req, res) => {
  const config = getConfigStatus();
  const configured = Object.entries(config).filter(([, v]) => v).map(([k]) => k);
  const notConfigured = Object.entries(config).filter(([, v]) => !v).map(([k]) => k);
  const manual = loadManualHoldings();
  const manualCount = Object.values(manual).reduce((s, h) => s + h.length, 0);

  res.send(`<!DOCTYPE html>
<html><head><title>Crypto Dashboard API</title><style>${SHARED_CSS}</style></head>
<body>
  ${NAV_HTML}
  <h1>Crypto Portfolio Dashboard</h1>
  <p>Backend API is running. ${configured.length}/${TOTAL_PLATFORMS} platforms configured${manualCount > 0 ? ` + ${manualCount} manual holding(s)` : ''}.</p>

  <div class="card">
    <h3 style="margin-top:0">Platform Status</h3>
    ${Object.entries(config).map(([name, ok]) => `
      <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
        <span><span class="dot ${ok ? "dot-ok" : "dot-off"}" style="${ok ? "background:#2ECC71" : "background:#555"}"></span>${name}</span>
        <span style="color:${ok ? "#2ECC71" : "#888"}">${ok ? "Configured" : "Not configured"}</span>
      </div>
    `).join("")}
    ${Object.keys(manual).length > 0 ? Object.entries(manual).map(([name, holdings]) => `
      <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
        <span><span class="dot dot-ok" style="background:#627EEA"></span>${name}</span>
        <span style="color:#627EEA">${holdings.length} manual holding(s)</span>
      </div>
    `).join("") : ""}
  </div>

  ${notConfigured.length > 0 ? `
    <div class="card">
      <h3 style="margin-top:0">Setup</h3>
      <p style="font-size:13px">Edit your <code>.env</code> file to add credentials for: ${notConfigured.join(", ")}</p>
      <p style="font-size:13px">Then restart the server.</p>
    </div>
  ` : ""}

  <div class="card">
    <h3 style="margin-top:0">API Endpoints</h3>
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><a href="/api/portfolio">/api/portfolio</a><span>Full portfolio + prices</span></div>
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><a href="/api/portfolio?refresh=true">/api/portfolio?refresh=true</a><span>Force refresh</span></div>
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><a href="/api/portfolio/balances">/api/portfolio/balances</a><span>Raw balances</span></div>
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><a href="/api/prices">/api/prices</a><span>Current prices</span></div>
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><a href="/api/health">/api/health</a><span>Health check</span></div>
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><a href="/api/status">/api/status</a><span>Config status</span></div>
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><a href="/api/manual">/api/manual</a><span>Manual holdings</span></div>
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><a href="/api/test-coinbase">/api/test-coinbase</a><span>Debug Coinbase auth</span></div>
  </div>
</body></html>`);
});

// Health check
app.get("/api/health", (req, res) => {
  const data = {
    status: "ok",
    uptime: process.uptime(),
    cacheAge: portfolioCache ? Date.now() - cacheTime : null,
    configuredPlatforms: getConfigStatus(),
  };
  respond(req, res, data, renderHealthHtml);
});

// Config status endpoint
app.get("/api/status", (req, res) => {
  const config = getConfigStatus();
  const configured = Object.entries(config).filter(([, v]) => v).map(([k]) => k);
  const data = {
    platforms: config,
    configuredCount: configured.length,
    totalPlatforms: TOTAL_PLATFORMS,
    configured,
  };
  respond(req, res, data, renderStatusHtml);
});

// Manual holdings — GET
app.get("/api/manual", (req, res) => {
  const manual = loadManualHoldings();
  if (req.query.format === "json") {
    return res.json(manual);
  }
  res.send(renderManualHtml(manual));
});

// Manual holdings — POST (update)
app.post("/api/manual", (req, res) => {
  try {
    const data = req.body;
    if (typeof data !== "object" || Array.isArray(data)) {
      return res.status(400).json({ error: 'Body must be an object like { "Platform": [{ "coin": "BTC", "amount": 0.5 }] }' });
    }
    saveManualHoldings(data);
    // Clear portfolio cache so next fetch includes updated manual holdings
    portfolioCache = null;
    res.json({ ok: true, holdings: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full portfolio with prices and classification
app.get("/api/portfolio", async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === "true";
    const { portfolio, platformStatus } = await getCachedPortfolio(forceRefresh);
    const configStatus = getConfigStatus();

    // Collect all unique coins
    const allCoins = new Set();
    for (const holdings of Object.values(portfolio)) {
      for (const h of holdings) allCoins.add(h.coin);
    }

    // Fetch prices (even if no coins, return empty gracefully)
    const prices = allCoins.size > 0 ? await fetchPrices([...allCoins]) : {};

    // Build enriched response
    const enriched = {};
    let totalValue = 0;

    for (const [exchange, holdings] of Object.entries(portfolio)) {
      enriched[exchange] = holdings.map((h) => {
        const priceInfo = prices[h.coin] || { usd: 0, change24h: 0 };
        const price = safeNum(priceInfo.usd);
        const value = safeNum(h.amount) * price;
        totalValue += value;
        return {
          coin: h.coin,
          amount: safeNum(h.amount),
          price,
          change24h: safeNum(priceInfo.change24h),
          value,
          category: classifyCoin(h.coin),
          ...(h.mint ? { mint: h.mint } : {}),
        };
      });
    }

    // Summary stats
    const byCategory = { Major: 0, Stablecoin: 0, Altcoin: 0 };
    const byExchange = {};
    const byCoin = {};

    for (const [exchange, holdings] of Object.entries(enriched)) {
      byExchange[exchange] = { total: 0, count: holdings.length };
      for (const h of holdings) {
        byCategory[h.category] += h.value;
        byExchange[exchange].total += h.value;
        if (!byCoin[h.coin]) {
          byCoin[h.coin] = { totalAmount: 0, totalValue: 0, price: h.price, category: h.category, change24h: h.change24h };
        }
        byCoin[h.coin].totalAmount += h.amount;
        byCoin[h.coin].totalValue += h.value;
      }
    }

    const configuredCount = Object.values(configStatus).filter(Boolean).length;

    const responseData = {
      portfolio: enriched,
      summary: {
        totalValue,
        byCategory,
        byExchange,
        byCoin,
        platforms: Object.keys(portfolio).length,
        assets: allCoins.size,
      },
      platformStatus,
      config: {
        ...configStatus,
        configuredCount,
        totalPlatforms: TOTAL_PLATFORMS,
      },
      meta: {
        priceSource: "coingecko",
        cacheAge: Date.now() - cacheTime,
        timestamp: new Date().toISOString(),
      },
    };

    respond(req, res, responseData, renderPortfolioHtml);
  } catch (err) {
    console.error("Portfolio error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Raw balances only
app.get("/api/portfolio/balances", async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === "true";
    const { portfolio, platformStatus } = await getCachedPortfolio(forceRefresh);
    const data = { portfolio, platformStatus, timestamp: new Date().toISOString() };
    respond(req, res, data, renderBalancesHtml);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Coinbase auth test/debug
app.get("/api/test-coinbase", async (req, res) => {
  try {
    const result = await testCoinbaseAuth();

    if (req.query.format === "json") {
      return res.json(result);
    }

    const statusColor = result.apiCallSuccess ? "#2ECC71" : "#E74C3C";
    const statusText = result.apiCallSuccess ? "SUCCESS" : "FAILED";

    // Build endpoint test rows
    const testRows = (result.tests || []).map(t => `
      <tr>
        <td><strong>${t.name}</strong></td>
        <td>${t.success ? '<span class="green">✓ OK</span>' : '<span class="red">✗ Failed</span>'}</td>
        <td class="num">${t.httpStatus || "N/A"}</td>
        <td class="muted">${t.success ? (t.accountCount + " accounts") : (t.error || "")}</td>
      </tr>
      ${!t.success && t.responseBody ? `<tr><td colspan="4"><pre style="margin:0;font-size:11px">${t.responseBody.slice(0, 300)}</pre></td></tr>` : ""}
    `).join("");

    // JWT payload debug info
    const jwtInfo = result.jwtPayload ? `
      <h2>JWT Payload (decoded)</h2>
      <pre>${JSON.stringify(result.jwtPayload, null, 2)}</pre>
    ` : "";

    res.send(`<!DOCTYPE html>
<html><head><title>Coinbase Auth Test — Crypto Dashboard</title><style>${SHARED_CSS}</style></head>
<body>
  ${NAV_HTML}
  <h1>Coinbase Auth Test</h1>
  <div class="sub">Tests both /v2 (App API) and /v3 (Advanced Trade) endpoints &middot; <a href="/api/test-coinbase?format=json" style="color:#627EEA">JSON</a></div>

  <div class="cards">
    <div class="card">
      <div class="card-label">Overall Result</div>
      <div class="card-value" style="color:${statusColor}">${statusText}</div>
    </div>
    <div class="card">
      <div class="card-label">Key Configured</div>
      <div class="card-value" style="color:${result.keyConfigured ? '#2ECC71' : '#E74C3C'}">${result.keyConfigured ? 'YES' : 'NO'}</div>
    </div>
    <div class="card">
      <div class="card-label">JWT Generated</div>
      <div class="card-value" style="color:${result.jwtGenerated ? '#2ECC71' : '#E74C3C'}">${result.jwtGenerated ? 'YES' : 'NO'}</div>
    </div>
  </div>

  <h2>Credential Check</h2>
  <table>
    <thead><tr><th>Field</th><th>Status</th><th>Details</th></tr></thead>
    <tbody>
      <tr>
        <td>API Key (COINBASE_API_KEY)</td>
        <td>${result.keyConfigured ? '<span class="green">✓</span>' : '<span class="red">✗</span>'}</td>
        <td class="muted">${result.keyPreview || ""}</td>
      </tr>
      <tr>
        <td>Private Key (COINBASE_API_SECRET)</td>
        <td>${result.secretConfigured ? '<span class="green">✓</span>' : '<span class="red">✗</span>'}</td>
        <td class="muted">${result.secretFormat || ""}</td>
      </tr>
    </tbody>
  </table>

  <h2>Endpoint Tests</h2>
  <table>
    <thead><tr><th>Endpoint</th><th>Result</th><th class="num">HTTP Status</th><th>Details</th></tr></thead>
    <tbody>${testRows}</tbody>
  </table>

  ${jwtInfo}

  ${result.error ? `
  <h2>Error Summary</h2>
  <pre>${result.error}</pre>
  ` : ""}

  <h2>Troubleshooting</h2>
  <div class="card" style="max-width:700px">
    <p style="font-size:13px;color:#888;margin:0">
      <strong>Common issues:</strong><br><br>
      1. <strong>401 on both endpoints</strong> — Your CDP API key may need specific permissions. Go to <a href="https://portal.cdp.coinbase.com" style="color:#627EEA">CDP Portal</a>, check that your key has "View" permission and is ECDSA (ES256), not Ed25519.<br><br>
      2. <strong>/v2 works but /v3 fails (or vice versa)</strong> — These are different APIs with different permission scopes. The dashboard will use whichever one works.<br><br>
      3. <strong>PEM format</strong> — In your <code>.env</code>, the secret must have <code>\\n</code> (literal backslash-n) between PEM lines, not actual newlines.<br><br>
      4. <strong>Key type</strong> — Must be a CDP API key with ECDSA/ES256, not Ed25519. Key name format: <code>organizations/{org}/apiKeys/{id}</code><br><br>
      5. <strong>Clock skew</strong> — JWT uses your system clock. If off by more than 30s, auth will fail.<br><br>
      6. <strong>Need new keys?</strong> — Go to <a href="https://portal.cdp.coinbase.com/access/api" style="color:#627EEA">CDP Portal → API Keys</a>. Create a new key, select <strong>ECDSA</strong> as the algorithm, and grant <strong>View</strong> permissions.
    </p>
  </div>
</body></html>`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Prices only
app.get("/api/prices", async (req, res) => {
  try {
    const coins = req.query.coins ? req.query.coins.split(",") : Object.keys(require("./services/prices").COINGECKO_IDS);
    const prices = await fetchPrices(coins);
    const data = { prices, timestamp: new Date().toISOString() };
    respond(req, res, data, renderPricesHtml);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start Server ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║       Crypto Portfolio Dashboard — Backend API        ║
║───────────────────────────────────────────────────────║
║  Server running on http://localhost:${PORT}              ║
║                                                       ║
║  Endpoints:                                           ║
║    GET /api/portfolio          Full portfolio          ║
║    GET /api/portfolio?refresh=true  Force refresh      ║
║    GET /api/portfolio/balances Raw balances             ║
║    GET /api/prices             Current prices          ║
║    GET /api/health             Health check            ║
║    GET /api/manual             Manual holdings         ║
║    GET /api/test-coinbase      Debug Coinbase auth     ║
╚═══════════════════════════════════════════════════════╝
  `);
});
