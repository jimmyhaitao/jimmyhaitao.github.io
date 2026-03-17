/**
 * CEX Connectors — Coinbase, OKX
 * Coinbase uses CDP JWT auth (ES256 EC private key) with the Coinbase App API (/v2).
 * OKX uses ccxt for unified exchange API access.
 * All keys must have READ-ONLY permissions.
 */
const ccxt = require("ccxt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const fetch = require("node-fetch");

function normalizeSymbol(symbol) {
  const map = { MATIC: "MATIC", POL: "MATIC" };
  const s = symbol.toUpperCase();
  return map[s] || s;
}

/**
 * Get parsed Coinbase credentials from environment.
 */
function getCoinbaseCredentials() {
  const keyId = process.env.COINBASE_API_KEY || "";
  // CRITICAL: dotenv stores \n as literal backslash-n in .env files.
  // We must convert them to real newlines for the PEM key to parse.
  const privateKey = (process.env.COINBASE_API_SECRET || "").replace(/\\n/g, "\n");
  return { keyId, privateKey };
}

/**
 * Generate a Coinbase CDP JWT for API authentication.
 * Uses ES256 (ECDSA with P-256 / SHA-256).
 *
 * IMPORTANT: The URI claim must use ONLY the path without query parameters.
 * e.g. "GET api.coinbase.com/v2/accounts" — NOT "/v2/accounts?limit=100"
 * This matches the official Coinbase example exactly.
 */
function generateCoinbaseJwt(method, path) {
  const { keyId, privateKey } = getCoinbaseCredentials();

  if (!privateKey || !privateKey.includes("BEGIN EC PRIVATE KEY")) {
    throw new Error(
      "COINBASE_API_SECRET must be a PEM-encoded EC private key. " +
      "Make sure the key in .env has \\n between lines (not actual newlines). " +
      "It should start with -----BEGIN EC PRIVATE KEY-----"
    );
  }

  // Strip query parameters from path for the URI claim
  const pathOnly = path.split("?")[0];
  const host = "api.coinbase.com";
  const uri = `${method} ${host}${pathOnly}`;
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    sub: keyId,
    iss: "cdp",
    nbf: now,
    exp: now + 120,
    uri,
  };

  // Match the official Coinbase example exactly: only kid + nonce
  const header = {
    kid: keyId,
    nonce: crypto.randomBytes(32).toString("hex"),
  };

  return jwt.sign(payload, privateKey, { algorithm: "ES256", header });
}

/**
 * Make an authenticated request to Coinbase API.
 * Works with both /v2 (App API) and /api/v3 (Advanced Trade) endpoints.
 */
async function coinbaseRequest(method, path) {
  const token = generateCoinbaseJwt(method, path);
  const url = `https://api.coinbase.com${path}`;

  console.log(`[Coinbase] ${method} ${path}`);

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Coinbase API ${res.status}: ${body.slice(0, 300)}`);
  }

  return res.json();
}

/**
 * Fetch Coinbase balances using the Coinbase App API (/v2/accounts).
 * This is the standard account listing endpoint — more reliable than Advanced Trade.
 *
 * Docs: https://docs.cdp.coinbase.com/coinbase-app/track-apis/accounts
 *
 * Falls back to Advanced Trade API (/api/v3/brokerage/accounts) if /v2 fails.
 */
async function fetchCoinbaseBalances() {
  const { keyId } = getCoinbaseCredentials();
  if (!keyId || keyId === "your_coinbase_api_key" ||
      keyId === "organizations/your-org-id/apiKeys/your-key-id") {
    console.log("[Coinbase] Skipped — no API key configured");
    return [];
  }

  // Strategy: try /v2/accounts first (Coinbase App API), fall back to /api/v3
  const strategies = [
    { name: "App API /v2", fetcher: fetchViaV2 },
    { name: "Advanced Trade /v3", fetcher: fetchViaV3 },
  ];

  for (const { name, fetcher } of strategies) {
    try {
      const holdings = await fetcher();
      if (holdings.length > 0) {
        console.log(`[Coinbase] ✓ ${name}: ${holdings.length} assets`);
        return holdings;
      }
      console.log(`[Coinbase] ${name}: returned 0 assets, trying next...`);
    } catch (err) {
      console.warn(`[Coinbase] ${name} failed: ${err.message}`);
    }
  }

  console.error("[Coinbase] All strategies failed");
  return [];
}

/**
 * Fetch balances via Coinbase App API /v2/accounts (paginated).
 * Response: { data: [{ currency: { code }, balance: { amount } }], pagination: { next_uri } }
 */
async function fetchViaV2() {
  const holdings = [];
  let path = "/v2/accounts?limit=100";

  while (path) {
    const data = await coinbaseRequest("GET", path);

    if (data.data && Array.isArray(data.data)) {
      for (const account of data.data) {
        const code = account.currency?.code || account.balance?.currency || "";
        const amount = parseFloat(account.balance?.amount || "0");
        const nativeValue = parseFloat(account.native_balance?.amount || "0");

        if (amount > 0 && code) {
          holdings.push({
            coin: normalizeSymbol(code),
            amount,
          });
        }
      }
    }

    // Pagination: next_uri is a relative path like "/v2/accounts?starting_after=..."
    path = data.pagination?.next_uri || null;
  }

  return holdings;
}

/**
 * Fetch balances via Advanced Trade API /api/v3/brokerage/accounts (paginated).
 * Response: { accounts: [{ currency, available_balance: { value }, hold: { value } }], cursor, has_next }
 */
async function fetchViaV3() {
  const holdings = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    const path = cursor
      ? `/api/v3/brokerage/accounts?limit=250&cursor=${cursor}`
      : "/api/v3/brokerage/accounts?limit=250";

    const data = await coinbaseRequest("GET", path);

    if (data.accounts) {
      for (const account of data.accounts) {
        const balance = parseFloat(account.available_balance?.value || "0");
        const hold = parseFloat(account.hold?.value || "0");
        const total = balance + hold;

        if (total > 0 && account.currency) {
          holdings.push({
            coin: normalizeSymbol(account.currency),
            amount: total,
          });
        }
      }
    }

    cursor = data.cursor;
    hasNext = !!data.has_next && !!cursor;
  }

  return holdings;
}

async function fetchOKXBalances() {
  if (!process.env.OKX_API_KEY || process.env.OKX_API_KEY === "your_okx_api_key") {
    console.log("[OKX] Skipped — no API key configured");
    return [];
  }

  try {
    const exchange = new ccxt.okx({
      apiKey: process.env.OKX_API_KEY,
      secret: process.env.OKX_API_SECRET,
      password: process.env.OKX_PASSPHRASE,
    });

    const merged = {};

    // Fetch trading account (unified account — includes spot, margin, futures)
    try {
      const trading = await exchange.fetchBalance({ type: "trading" });
      for (const [coin, amount] of Object.entries(trading.total || {})) {
        if (amount > 0) {
          const sym = normalizeSymbol(coin);
          merged[sym] = (merged[sym] || 0) + amount;
        }
      }
      console.log(`[OKX] Trading account: ${Object.keys(trading.total || {}).filter(k => trading.total[k] > 0).length} coins`);
    } catch (e) {
      console.warn("[OKX] Could not fetch trading balance:", e.message);
    }

    // Fetch funding account (separate from trading — used for deposits/withdrawals)
    try {
      const funding = await exchange.fetchBalance({ type: "funding" });
      for (const [coin, amount] of Object.entries(funding.total || {})) {
        if (amount > 0) {
          const sym = normalizeSymbol(coin);
          merged[sym] = (merged[sym] || 0) + amount;
        }
      }
      console.log(`[OKX] Funding account: ${Object.keys(funding.total || {}).filter(k => funding.total[k] > 0).length} coins`);
    } catch (e) {
      console.warn("[OKX] Could not fetch funding balance:", e.message);
    }

    // NOTE: OKX unified accounts include earn/savings in the trading balance.
    // Fetching savings separately would double-count.

    const holdings = Object.entries(merged).map(([coin, amount]) => ({ coin, amount }));
    console.log(`[OKX] Fetched ${holdings.length} unique assets (trading + funding, no overlap)`);
    return holdings;
  } catch (err) {
    console.error("[OKX] Error:", err.message);
    return [];
  }
}

async function fetchBybitBalances() {
  if (!process.env.BYBIT_API_KEY || process.env.BYBIT_API_KEY === "your_bybit_api_key") {
    console.log("[Bybit] Skipped — no API key configured");
    return [];
  }

  try {
    const exchange = new ccxt.bybit({
      apiKey: process.env.BYBIT_API_KEY,
      secret: process.env.BYBIT_API_SECRET,
    });

    // Fetch unified account balance
    const balance = await exchange.fetchBalance({ type: "unified" });
    const merged = {};

    for (const [coin, info] of Object.entries(balance.total || {})) {
      if (info > 0) {
        const sym = normalizeSymbol(coin);
        merged[sym] = (merged[sym] || 0) + info;
      }
    }

    // Also try funding wallet
    try {
      const funding = await exchange.fetchBalance({ type: "fund" });
      for (const [coin, info] of Object.entries(funding.total || {})) {
        if (info > 0) {
          const sym = normalizeSymbol(coin);
          merged[sym] = (merged[sym] || 0) + info;
        }
      }
    } catch (e) {
      // fund wallet might not exist
    }

    const holdings = Object.entries(merged).map(([coin, amount]) => ({ coin, amount }));
    console.log(`[Bybit] Fetched ${holdings.length} assets`);
    return holdings;
  } catch (err) {
    // Detect geo-blocking from CloudFront
    if (err.message && err.message.includes("403") && err.message.includes("CloudFront")) {
      console.error("[Bybit] BLOCKED: Bybit API is geo-restricted from your country/IP.");
      console.error("[Bybit] To fix: connect through a VPN to a supported country (US, EU, etc.)");
      return [];
    }
    console.error("[Bybit] Error:", err.message.slice(0, 200));
    return [];
  }
}

/**
 * Test Coinbase API authentication — diagnostic endpoint.
 * Tries BOTH /v2 (App API) and /v3 (Advanced Trade) endpoints.
 * Returns detailed debug info for troubleshooting.
 */
async function testCoinbaseAuth() {
  const result = {
    keyConfigured: false,
    secretConfigured: false,
    secretFormat: null,
    jwtGenerated: false,
    tests: [],
    error: null,
  };

  try {
    const { keyId, privateKey } = getCoinbaseCredentials();

    result.keyConfigured = !!keyId && keyId !== "your_coinbase_api_key" &&
      keyId !== "organizations/your-org-id/apiKeys/your-key-id";
    result.secretConfigured = !!privateKey && privateKey.includes("BEGIN EC PRIVATE KEY");
    result.keyPreview = keyId ? keyId.slice(0, 40) + "..." : "(empty)";
    result.secretFormat = privateKey.includes("BEGIN EC PRIVATE KEY")
      ? "Valid PEM format"
      : privateKey.length > 0
        ? `Invalid format (${privateKey.length} chars, starts with: ${privateKey.slice(0, 20)}...)`
        : "(empty)";

    if (!result.keyConfigured || !result.secretConfigured) {
      result.error = "API key or secret not properly configured";
      return result;
    }

    // Try generating JWT (quick check)
    const testToken = generateCoinbaseJwt("GET", "/v2/accounts?limit=1");
    result.jwtGenerated = true;
    result.jwtPreview = testToken.slice(0, 50) + "...";

    // Decode JWT to show payload for debugging
    const parts = testToken.split(".");
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(Buffer.from(parts[1], "base64").toString());
        result.jwtPayload = {
          iss: payload.iss,
          sub: payload.sub ? payload.sub.slice(0, 40) + "..." : "",
          uri: payload.uri,
          exp: new Date(payload.exp * 1000).toISOString(),
        };
      } catch (_) {}
    }

    // Test both API endpoints
    const endpoints = [
      { name: "App API /v2", path: "/v2/accounts?limit=1" },
      { name: "Advanced Trade /v3", path: "/api/v3/brokerage/accounts?limit=1" },
    ];

    for (const ep of endpoints) {
      const test = { name: ep.name, path: ep.path, success: false, httpStatus: null, responseBody: null, error: null };
      try {
        const token = generateCoinbaseJwt("GET", ep.path);
        const url = `https://api.coinbase.com${ep.path}`;
        const res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        });
        test.httpStatus = res.status;
        const body = await res.text();
        test.responseBody = body.slice(0, 500);
        if (res.ok) {
          test.success = true;
          const data = JSON.parse(body);
          // /v2 returns { data: [...] }, /v3 returns { accounts: [...] }
          test.accountCount = (data.data || data.accounts || []).length;
        } else {
          test.error = `HTTP ${res.status}`;
        }
      } catch (err) {
        test.error = err.message;
      }
      result.tests.push(test);
    }

    // Overall success if either endpoint works
    result.apiCallSuccess = result.tests.some(t => t.success);
    if (!result.apiCallSuccess) {
      result.error = "Both API endpoints failed. See individual test results.";
    }
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

module.exports = {
  fetchCoinbaseBalances,
  fetchOKXBalances,
  fetchBybitBalances,
  testCoinbaseAuth,
};
