/**
 * Price Service — CoinGecko (primary) + Coinbase (fallback)
 * Fetches all prices in single batch requests to minimize rate limiting.
 */
const fetch = require("node-fetch");

// CoinGecko IDs — primary source
const COINGECKO_IDS = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", XRP: "ripple",
  USDT: "tether", USDC: "usd-coin", BNB: "binancecoin", DOGE: "dogecoin",
  LINK: "chainlink", ARB: "arbitrum", HYPE: "hyperliquid",
  CAKE: "pancakeswap-token", UNI: "uniswap", AAVE: "aave",
  MATIC: "matic-network", RAY: "raydium", BONK: "bonk",
  JUP: "jupiter-exchange-solana", JTO: "jito-governance-token",
  DAI: "dai", WBTC: "wrapped-bitcoin", WETH: "weth",
  SHIB: "shiba-inu", AVAX: "avalanche-2", PYTH: "pyth-network",
  W: "wormhole", mSOL: "msol", stSOL: "lido-staked-sol",
  bSOL: "blazestake-staked-sol", jitoSOL: "jito-staked-sol",
  BTCB: "bitcoin",
  MON: "mon-protocol",
  TRUMP: "official-trump",
  PENGU: "pudgy-penguins",
  PEPE: "pepe",
  LAYER: "solayer",
  OKSOL: "oksol",
  MNDE: "marinade",
  BLZE: "blazestake",
  STEP: "step-finance",
  KMNO: "kamino",
  WIF: "dogwifcoin",
  DRIFT: "drift-protocol",
  ORCA: "orca",
  RENDER: "render-token",
  MOBILE: "helium-mobile",
  NEON: "neon",
  SYRUP: "maple-finance",
  MORPHO: "morpho",
  DOT: "polkadot",
  VET: "vechain",
  ATOM: "cosmos",
};

// Coinbase price endpoint symbols (used as fallback)
// Coinbase public /v2/prices/XXX-USD/spot requires no auth
const COINBASE_SYMBOLS = {
  BTC: "BTC", ETH: "ETH", SOL: "SOL", XRP: "XRP", BNB: "BNB",
  DOGE: "DOGE", LINK: "LINK", ARB: "ARB", UNI: "UNI", AAVE: "AAVE",
  MATIC: "MATIC", SHIB: "SHIB", AVAX: "AVAX", DOT: "DOT", VET: "VET",
  ATOM: "ATOM", TRUMP: "TRUMP", PENGU: "PENGU", PEPE: "PEPE",
  MON: "MON", MORPHO: "MORPHO", SYRUP: "SYRUP", HYPE: "HYPE",
  BONK: "BONK", JUP: "JUP", JTO: "JTO", PYTH: "PYTH",
  RENDER: "RENDER", WIF: "WIF", DRIFT: "DRIFT", KMNO: "KMNO",
  LAYER: "LAYER", ORCA: "ORCA", NEON: "NEON", RAY: "RAY",
  CAKE: "CAKE",
};

// Stablecoins — always $1
const STABLECOINS = { USDT: 1, USDC: 1, DAI: 1 };

// Cache
let priceCache = {};
let lastFetchTime = 0;
let lastFetchSuccess = false;
const CACHE_TTL = 60 * 1000; // 1 minute

/**
 * Fetch all prices from CoinGecko in a single batch request.
 */
async function fetchFromCoinGecko(coins) {
  const prices = {};
  const ids = new Set();
  for (const coin of coins) {
    const id = COINGECKO_IDS[coin.toUpperCase()];
    if (id) ids.add(id);
  }
  if (ids.size === 0) return prices;

  try {
    const idString = [...ids].join(",");
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${idString}&vs_currencies=usd&include_24hr_change=true`;

    console.log(`[Prices] CoinGecko: fetching ${ids.size} prices...`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`[Prices] CoinGecko error: ${res.status} ${body.slice(0, 100)}`);
        return prices;
      }

      const data = await res.json();
      for (const [symbol, geckoId] of Object.entries(COINGECKO_IDS)) {
        if (data[geckoId]) {
          prices[symbol] = {
            usd: data[geckoId].usd,
            change24h: data[geckoId].usd_24h_change || 0,
          };
        }
      }
      console.log(`[Prices] CoinGecko: ${Object.keys(prices).length} prices fetched`);
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.warn(`[Prices] CoinGecko error: ${err.message}`);
  }
  return prices;
}

/**
 * Fetch missing prices from Coinbase public API (no auth needed).
 * Uses /v2/exchange-rates?currency=USD — returns ALL rates in one call.
 */
async function fetchFromCoinbase(missingCoins) {
  const prices = {};
  if (missingCoins.length === 0) return prices;

  try {
    const url = "https://api.coinbase.com/v2/exchange-rates?currency=USD";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) {
        console.warn(`[Prices] Coinbase rates error: ${res.status}`);
        return prices;
      }

      const data = await res.json();
      const rates = data?.data?.rates || {};

      // rates are inverted: 1 USD = X tokens, so price = 1/rate
      for (const coin of missingCoins) {
        const sym = COINBASE_SYMBOLS[coin.toUpperCase()];
        if (sym && rates[sym]) {
          const rate = parseFloat(rates[sym]);
          if (rate > 0) {
            prices[coin.toUpperCase()] = { usd: 1 / rate, change24h: 0 };
          }
        }
      }
      console.log(`[Prices] Coinbase: ${Object.keys(prices).length}/${missingCoins.length} fallback prices fetched`);
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.warn(`[Prices] Coinbase rates error: ${err.message}`);
  }
  return prices;
}

async function fetchPrices(coins) {
  const now = Date.now();

  // Return cache if fresh AND it covers most requested coins
  if (now - lastFetchTime < CACHE_TTL && Object.keys(priceCache).length > 0) {
    const allCoins = [...new Set(coins.map(c => c.toUpperCase()))];
    const covered = allCoins.filter(c => priceCache[c] || STABLECOINS[c]).length;
    if (covered >= allCoins.length * 0.7) {
      return priceCache;
    }
    console.log(`[Prices] Cache only covers ${covered}/${allCoins.length} coins, re-fetching...`);
  }

  try {
    // Step 1: Fetch all from CoinGecko (single batch)
    const geckoPrices = await fetchFromCoinGecko(coins);

    // Step 2: Find coins still missing
    const allCoins = [...new Set(coins.map(c => c.toUpperCase()))];
    const missing = allCoins.filter(c => !geckoPrices[c] && !STABLECOINS[c]);

    // Step 3: Fetch missing from Coinbase public rates
    let coinbasePrices = {};
    if (missing.length > 0) {
      console.log(`[Prices] ${missing.length} missing from CoinGecko, trying Coinbase: ${missing.join(", ")}`);
      coinbasePrices = await fetchFromCoinbase(missing);
    }

    // Merge: CoinGecko takes priority (has 24h change), then Coinbase
    const prices = { ...coinbasePrices, ...geckoPrices };

    // Stablecoins always $1
    for (const [coin, usd] of Object.entries(STABLECOINS)) {
      if (!prices[coin]) {
        prices[coin] = { usd, change24h: 0 };
      }
    }

    // Wrapped tokens mirror base
    if (prices.BTC) {
      if (!prices.WBTC) prices.WBTC = { ...prices.BTC };
      if (!prices.BTCB) prices.BTCB = { ...prices.BTC };
    }
    if (prices.ETH && !prices.WETH) prices.WETH = { ...prices.ETH };
    if (prices.SOL) {
      if (!prices.mSOL) prices.mSOL = { usd: prices.SOL.usd * 1.08, change24h: prices.SOL.change24h };
      if (!prices.jitoSOL) prices.jitoSOL = { usd: prices.SOL.usd * 1.07, change24h: prices.SOL.change24h };
      if (!prices.bSOL) prices.bSOL = { usd: prices.SOL.usd * 1.05, change24h: prices.SOL.change24h };
      if (!prices.stSOL) prices.stSOL = { usd: prices.SOL.usd * 1.06, change24h: prices.SOL.change24h };
      if (!prices.OKSOL) prices.OKSOL = { usd: prices.SOL.usd * 1.05, change24h: prices.SOL.change24h };
    }

    const totalFetched = Object.keys(prices).length;
    if (totalFetched > 0) {
      priceCache = { ...priceCache, ...prices };
      lastFetchTime = now;
      lastFetchSuccess = true;
      console.log(`[Prices] Total: ${totalFetched} live prices cached`);
    } else {
      lastFetchTime = now;
      lastFetchSuccess = false;
      console.warn("[Prices] No prices fetched from any source");
    }

    return priceCache;
  } catch (err) {
    console.error("[Prices] Fetch error:", err.message);
    lastFetchTime = now;
    lastFetchSuccess = false;
    return priceCache;
  }
}

function getPriceStatus() {
  return {
    lastFetchSuccess,
    cachedPriceCount: Object.keys(priceCache).length,
    cacheAge: lastFetchTime ? Date.now() - lastFetchTime : null,
    usingFallback: !lastFetchSuccess,
  };
}

module.exports = { fetchPrices, COINGECKO_IDS, getPriceStatus };
