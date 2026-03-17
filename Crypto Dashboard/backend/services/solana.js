/**
 * Solana Connectors — Phantom Wallet + Kamino
 *
 * Phantom: Tries Jupiter Ultra API first (requires API key from portal.jup.ag).
 * Falls back to Solana RPC with a verified mint whitelist if Jupiter fails.
 *
 * Kamino: On-chain kToken detection — downloads the Kamino strategies list,
 * then matches wallet SPL token holdings against kToken shareMints.
 * Falls back to Kamino REST API endpoints if they ever start working.
 */
const { Connection, PublicKey } = require("@solana/web3.js");
const fetch = require("node-fetch");
const { fetchPrices } = require("./prices");

// Jupiter — try api.jup.ag first (requires key), then lite-api.jup.ag
const JUPITER_APIS = [
  "https://api.jup.ag",
  "https://lite-api.jup.ag",
];
const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

// ─── Mint → Symbol map (correct, verified addresses) ────────────
const MINT_TO_SYMBOL = {
  // Stablecoins
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",

  // Major
  "So11111111111111111111111111111111111111112":   "SOL",

  // Liquid staking
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So": "mSOL",
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj": "stSOL",
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1": "bSOL",
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn": "jitoSOL",

  // DeFi / Governance
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": "JUP",
  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL": "JTO",
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": "RAY",
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": "BONK",
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3": "PYTH",
  "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ": "W",
  "KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS": "KMNO",
  "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE": "ORCA",
  "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof": "RENDER",
  "C8mJikjoE2wpmzdond98PCUdvFT7Nk7C9qCeL9876JXj": "DRIFT",
  "MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey": "MNDE",
  "BLZEEuZUBVqFhj8adcCFPJvPVCiCyVmh3hkJMrU8KuJA": "BLZE",
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": "WIF",
  "WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk": "WEN",
  "StepAscQoEioFxxWGnh2sLBDFp9d8rvKz2Yp39iDpyT": "STEP",
};

// Cache symbol lookups resolved via Jupiter token API
const tokenSymbolCache = {};

/**
 * Resolve a Solana mint address to its token symbol.
 * Checks local map first, then queries Jupiter token API for unknowns.
 */
async function resolveTokenSymbol(mint) {
  if (mint === "SOL") return "SOL";
  if (MINT_TO_SYMBOL[mint]) return MINT_TO_SYMBOL[mint];
  if (tokenSymbolCache[mint] !== undefined) return tokenSymbolCache[mint];

  // Try each Jupiter API base
  for (const base of JUPITER_APIS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`${base}/tokens/v1/token/${mint}`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        const symbol = data.symbol || null;
        tokenSymbolCache[mint] = symbol;
        return symbol;
      }
    } catch (_) {}
  }

  tokenSymbolCache[mint] = null;
  return null;
}

async function fetchPhantomBalances() {
  const address = process.env.SOLANA_ADDRESS;
  if (!address || address === "YourSolanaPublicKey") {
    console.log("[Phantom] Skipped — no Solana address configured");
    return [];
  }

  // ── Primary: Jupiter Ultra API ──────────────────────────────
  // Jupiter Ultra requires an API key (set JUPITER_API_KEY in .env).
  // If no key is set, skip straight to RPC fallback.
  const apiKey = process.env.JUPITER_API_KEY;

  for (const base of JUPITER_APIS) {
    try {
      const url = `${base}/ultra/v1/balances?walletAddress=${address}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const headers = { Accept: "application/json" };
      if (apiKey) headers["x-api-key"] = apiKey;
      const res = await fetch(url, { signal: controller.signal, headers });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        const holdings = [];
        let resolvedUnknown = 0;
        let skipped = 0;

        for (const [mint, info] of Object.entries(data)) {
          const uiAmount = info.uiAmount || 0;
          if (uiAmount <= 0) continue;

          const symbol = await resolveTokenSymbol(mint);
          if (!symbol) { skipped++; continue; }

          holdings.push({ coin: symbol, amount: uiAmount });
          if (!MINT_TO_SYMBOL[mint] && mint !== "SOL") resolvedUnknown++;
        }

        if (resolvedUnknown > 0) console.log(`[Phantom] Resolved ${resolvedUnknown} token symbols via Jupiter API`);
        if (skipped > 0) console.log(`[Phantom] Skipped ${skipped} tokens with unresolvable symbols`);
        console.log(`[Phantom] Fetched ${holdings.length} assets via Jupiter (${base})`);
        return holdings;
      }
      console.warn(`[Phantom] Jupiter ${base} returned ${res.status}`);
    } catch (err) {
      console.warn(`[Phantom] Jupiter ${base} failed (${err.message})`);
    }
  }

  console.log("[Phantom] Jupiter API unavailable — falling back to RPC");
  return fetchPhantomViaRPC(address);
}

async function fetchPhantomViaRPC(address) {
  try {
    const connection = getConnection();
    const pubkey = new PublicKey(address);
    const holdings = [];

    const solBalance = await connection.getBalance(pubkey);
    if (solBalance > 0) holdings.push({ coin: "SOL", amount: solBalance / 1e9 });

    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, {
      programId: TOKEN_PROGRAM_ID,
    });

    let skipped = 0;
    for (const { account } of tokenAccounts.value) {
      const parsed = account.data.parsed?.info;
      if (!parsed) continue;
      const mint = parsed.mint;
      const amount = parseFloat(parsed.tokenAmount?.uiAmountString || "0");
      if (amount <= 0) continue;
      const symbol = MINT_TO_SYMBOL[mint];
      if (symbol) holdings.push({ coin: symbol, amount });
      else skipped++;
    }

    if (skipped > 0) console.log(`[Phantom/RPC] Skipped ${skipped} unrecognized mints`);
    console.log(`[Phantom/RPC] Fetched ${holdings.length} assets`);
    return holdings;
  } catch (err) {
    if (err.message && err.message.includes("429")) {
      console.warn("[Phantom/RPC] Rate limited by Solana RPC — skipping (set SOLANA_RPC_URL for a private endpoint)");
    } else {
      console.error("[Phantom/RPC] Error:", err.message);
    }
    return [];
  }
}

// Reuse a single RPC connection
let _connection = null;
function getConnection() {
  if (!_connection) {
    _connection = new Connection(SOLANA_RPC, { commitment: "confirmed" });
    console.log(`[Solana] Using RPC: ${SOLANA_RPC}`);
  }
  return _connection;
}

// ═══════════════════════════════════════════════════════════════
// KAMINO — On-chain kToken detection
// ═══════════════════════════════════════════════════════════════
//
// Strategy:
//   1. Download Kamino strategies list (includes shareMint for each vault)
//   2. Build a shareMint → strategy lookup map
//   3. Get the wallet's SPL token accounts via Solana RPC
//   4. Match token mints against Kamino shareMints
//   5. Calculate USD value using strategy sharePrice / TVL data
//
// Falls back to REST API endpoints if the on-chain method fails.

// Cache the strategies list (refresh every 10 minutes)
let _kaminoStrategiesCache = null;
let _kaminoStrategiesCacheTime = 0;
const KAMINO_STRATEGIES_TTL = 10 * 60 * 1000;
/** Get SOL price from the main price cache (CoinGecko). */
async function getSolPrice() {
  const prices = await fetchPrices(["SOL"]);
  const sol = prices.SOL;
  return (sol && sol.usd) || 0;
}

/**
 * Fetch all Kamino strategies. Returns a Map<shareMint, strategyInfo>.
 */
async function getKaminoStrategiesMap() {
  const now = Date.now();
  if (_kaminoStrategiesCache && now - _kaminoStrategiesCacheTime < KAMINO_STRATEGIES_TTL) {
    return _kaminoStrategiesCache;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000); // 30s for large response
  try {
    const res = await fetch("https://api.kamino.finance/strategies", {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[Kamino] Strategies list returned HTTP ${res.status}`);
      return null;
    }
    const strategies = await res.json();
    if (!Array.isArray(strategies)) {
      console.warn("[Kamino] Strategies response is not an array");
      return null;
    }

    const map = new Map();
    for (const s of strategies) {
      if (s.shareMint) {
        map.set(s.shareMint, s);
      }
    }
    console.log(`[Kamino] Loaded ${map.size} strategies (from ${strategies.length} total)`);
    _kaminoStrategiesCache = map;
    _kaminoStrategiesCacheTime = now;
    return map;
  } catch (e) {
    clearTimeout(timer);
    console.warn(`[Kamino] Failed to fetch strategies list: ${e.message}`);
    return null;
  }
}

/**
 * Get wallet's SPL token accounts (mint, balance).
 * Queries BOTH the original Token Program AND Token-2022 (Token Extensions).
 * Kamino kTokens may use either program.
 * Returns array of { mint, amount, decimals }.
 * Results are cached for 30s to avoid duplicate RPC calls within a single refresh.
 */
let _walletTokenCache = null;
let _walletTokenCacheTime = 0;
const WALLET_TOKEN_CACHE_TTL = 30_000;

async function getWalletTokenAccounts(walletAddress) {
  const now = Date.now();
  if (_walletTokenCache && now - _walletTokenCacheTime < WALLET_TOKEN_CACHE_TTL) {
    return _walletTokenCache;
  }
  const connection = getConnection();
  const pubkey = new PublicKey(walletAddress);

  // Query both token programs in parallel
  const [spl, token2022] = await Promise.allSettled([
    connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);

  const tokens = [];
  const sources = [
    { result: spl, label: "SPL" },
    { result: token2022, label: "Token-2022" },
  ];

  for (const { result, label } of sources) {
    if (result.status !== "fulfilled") continue;
    let count = 0;
    for (const { account } of result.value.value) {
      const parsed = account.data.parsed?.info;
      if (!parsed) continue;
      const mint = parsed.mint;
      const amount = parseFloat(parsed.tokenAmount?.uiAmountString || "0");
      const decimals = parsed.tokenAmount?.decimals || 0;
      if (amount > 0) {
        tokens.push({ mint, amount, decimals });
        count++;
      }
    }
    if (count > 0) console.log(`[Kamino] ${label} program: ${count} token accounts with balance`);
  }

  _walletTokenCache = tokens;
  _walletTokenCacheTime = Date.now();
  return tokens;
}

/**
 * Fetch the USD price of one or more token mints via Jupiter Price API v2.
 * Returns a Map<mint, priceUSD>.
 */
async function fetchJupiterPrices(mints) {
  const prices = new Map();
  if (mints.length === 0) return prices;

  const ids = mints.join(",");
  for (const base of JUPITER_APIS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${base}/price/v2?ids=${ids}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timer);
      if (!res.ok) continue;

      const body = await res.json();
      const data = body.data || body;
      for (const [mint, info] of Object.entries(data)) {
        const p = parseFloat(info?.price || 0);
        if (p > 0) prices.set(mint, p);
      }
      if (prices.size > 0) {
        console.log(`[Kamino] Jupiter prices: fetched ${prices.size} kToken price(s) via ${base}`);
        return prices;
      }
    } catch (_) {}
  }
  return prices;
}

/**
 * Detect Kamino kToken holdings on-chain and calculate their USD value.
 *
 * Approach:
 *   1. Match wallet SPL tokens (both SPL + Token-2022) against Kamino strategy shareMints
 *   2. Resolve token pair names from tokenAMint/tokenBMint
 *   3. Get kToken prices from Jupiter Price API v2
 *   4. Fallback: use kToken supply + vault balance ratio
 *   5. Fallback: use kToken supply + underlying token prices × estimated amounts
 */
async function fetchKaminoViaOnChain(walletAddress) {
  const holdings = [];

  // 1. Load Kamino strategies map (shareMint → strategy info with tokenAMint/tokenBMint)
  const strategiesMap = await getKaminoStrategiesMap();
  if (!strategiesMap || strategiesMap.size === 0) {
    console.log("[Kamino] Could not load strategies — skipping on-chain detection");
    return holdings;
  }

  // 2. Get all SPL + Token-2022 token accounts for this wallet
  const walletTokens = await getWalletTokenAccounts(walletAddress);
  console.log(`[Kamino] Wallet has ${walletTokens.length} token accounts (SPL + Token-2022), checking against ${strategiesMap.size} kToken mints...`);

  // 3. Match against Kamino strategies
  const matched = [];
  for (const { mint, amount } of walletTokens) {
    const strategy = strategiesMap.get(mint);
    if (!strategy) continue;
    matched.push({ mint, amount, strategy });
  }

  if (matched.length === 0) {
    console.log("[Kamino] No kToken matches found in wallet");
    return holdings;
  }

  console.log(`[Kamino] Matched ${matched.length} kToken position(s), resolving values...`);

  // 4. Resolve token symbols for each matched strategy
  const resolvedMatches = [];
  for (const m of matched) {
    const tokenAMint = m.strategy.tokenAMint;
    const tokenBMint = m.strategy.tokenBMint;
    const symbolA = MINT_TO_SYMBOL[tokenAMint] || (await resolveTokenSymbol(tokenAMint)) || tokenAMint?.slice(0, 8) || "?";
    const symbolB = MINT_TO_SYMBOL[tokenBMint] || (await resolveTokenSymbol(tokenBMint)) || tokenBMint?.slice(0, 8) || "?";
    resolvedMatches.push({ ...m, symbolA, symbolB, label: `${symbolA}-${symbolB}` });
  }

  // 5. Try to get kToken prices from Jupiter Price API
  const shareMints = resolvedMatches.map(m => m.mint);
  const kTokenPrices = await fetchJupiterPrices(shareMints);

  const solPrice = await getSolPrice();

  // 6. Calculate value for each position
  for (const m of resolvedMatches) {
    const { mint: shareMint, amount: userKTokens, strategy, symbolA, symbolB, label } = m;
    let usdValue = 0;

    // Method 1: Jupiter kToken price (most accurate — market price of the kToken itself)
    const kPrice = kTokenPrices.get(shareMint);
    if (kPrice && kPrice > 0) {
      usdValue = userKTokens * kPrice;
      console.log(`[Kamino] ${label}: ${userKTokens.toFixed(4)} kTokens × $${kPrice.toFixed(6)} (Jupiter) = $${usdValue.toFixed(2)}`);
    }

    // Method 2: Kamino metrics API sharePrice (works for CL-deployed vaults)
    if (usdValue === 0) {
      try {
        const metricsRes = await fetch(`https://api.kamino.finance/strategies/${strategy.address}/metrics`, {
          headers: { Accept: "application/json" },
          timeout: 10000,
        });
        if (metricsRes.ok) {
          const metrics = await metricsRes.json();
          const sharePrice = parseFloat(metrics.sharePrice || "0");
          if (sharePrice > 0) {
            usdValue = userKTokens * sharePrice;
            console.log(`[Kamino] ${label}: ${userKTokens.toFixed(4)} kTokens × $${sharePrice.toFixed(6)} (metrics API) = $${usdValue.toFixed(2)}`);
          }
        }
      } catch (err) {
        console.warn(`[Kamino] ${label}: metrics API error: ${err.message}`);
      }
    }

    // Method 3 (removed): vault balance ratio was unreliable for CL-deployed vaults.
    // The metrics API (Method 2) is the reliable fallback.

    // Record the holding (denominated in SOL)
    if (usdValue > 0.01) {
      const solAmount = solPrice > 0 ? usdValue / solPrice : 0;
      holdings.push({ coin: "SOL", amount: solAmount, label: `Kamino LP (${label})` });
    } else {
      // No price available — record raw kToken amounts so user sees something
      console.log(`[Kamino] ${label}: could not determine USD value for ${userKTokens.toFixed(4)} kTokens`);
      holdings.push({ coin: symbolA, amount: 0, label: `Kamino LP (${label}) — no price` });
    }
  }

  console.log(`[Kamino] Resolved ${holdings.length} position(s) from ${matched.length} kToken match(es)`);
  return holdings;
}

/**
 * Detect kTokens staked in Kamino farms (FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr).
 * When users stake kTokens for KMNO rewards, the tokens are transferred to a farm vault
 * and no longer appear in the wallet. This queries the farm program's UserState accounts.
 */
const KAMINO_FARMS_PROGRAM = "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr";

async function fetchKaminoStakedPositions(walletAddress, strategiesMap, solPrice = 0) {
  const { UserState } = require("@kamino-finance/farms-sdk/dist/@codegen/farms/accounts/UserState");
  const { FarmState } = require("@kamino-finance/farms-sdk/dist/@codegen/farms/accounts/FarmState");

  const connection = getConnection();
  const walletPk = new PublicKey(walletAddress);

  // Find all UserState accounts for this wallet (owner at offset 48)
  const userAccounts = await connection.getProgramAccounts(new PublicKey(KAMINO_FARMS_PROGRAM), {
    filters: [{ memcmp: { offset: 48, bytes: walletPk.toBase58() } }],
  });

  // Decode and filter to non-zero stakes
  const activeStates = [];
  const farmPubkeys = [];
  for (const { account } of userAccounts) {
    try {
      const state = UserState.decode(account.data);
      const activeScaled = BigInt(state.activeStakeScaled.toString());
      if (activeScaled > 0n) {
        activeStates.push({ state, activeScaled });
        farmPubkeys.push(new PublicKey(state.farmState.toString()));
      }
    } catch (_) {}
  }

  if (activeStates.length === 0) return [];
  console.log(`[Kamino] Found ${activeStates.length} staked farm position(s)`);

  // Batch-fetch farm accounts to get the staked token mint
  const farmInfos = await connection.getMultipleAccountsInfo(farmPubkeys);

  const holdings = [];
  for (let i = 0; i < activeStates.length; i++) {
    const { activeScaled } = activeStates[i];
    const farmInfo = farmInfos[i];
    if (!farmInfo) continue;

    let tokenMint, decimals = 6;
    try {
      const farmState = FarmState.decode(farmInfo.data);
      tokenMint = farmState.token.mint.toString();
      decimals = farmState.token.decimals ? Number(farmState.token.decimals) : 6;
    } catch (_) { continue; }

    // Only process mints that match a Kamino strategy (skip KMNO token staking etc.)
    const strategy = strategiesMap.get(tokenMint);
    if (!strategy) continue;

    // Convert scaled amount to UI amount (÷ 10^(18 + decimals))
    const stakeAmount = Number(activeScaled) / Math.pow(10, 18 + decimals);
    if (stakeAmount < 0.0001) continue;

    // Get USD value via Kamino metrics API sharePrice
    let usdValue = 0;
    try {
      const mRes = await fetch(`https://api.kamino.finance/strategies/${strategy.address}/metrics`, {
        headers: { Accept: "application/json" },
      });
      if (mRes.ok) {
        const metrics = await mRes.json();
        const sharePrice = parseFloat(metrics.sharePrice || "0");
        if (sharePrice > 0) usdValue = stakeAmount * sharePrice;
      }
    } catch (_) {}

    const tokenAMint = strategy.tokenAMint;
    const tokenBMint = strategy.tokenBMint;
    const symbolA = MINT_TO_SYMBOL[tokenAMint] || (await resolveTokenSymbol(tokenAMint)) || tokenAMint?.slice(0, 8) || "?";
    const symbolB = MINT_TO_SYMBOL[tokenBMint] || (await resolveTokenSymbol(tokenBMint)) || tokenBMint?.slice(0, 8) || "?";
    const label = `${symbolA}-${symbolB}`;

    if (usdValue > 0.01) {
      const solAmount = solPrice > 0 ? usdValue / solPrice : 0;
      console.log(`[Kamino] ${label} (staked): ${stakeAmount.toFixed(4)} kTokens → $${usdValue.toFixed(2)} (${solAmount.toFixed(4)} SOL)`);
      holdings.push({ coin: "SOL", amount: solAmount, label: `Kamino LP (${label})` });
    } else {
      console.log(`[Kamino] ${label} (staked): ${stakeAmount.toFixed(4)} kTokens — no price`);
    }
  }

  return holdings;
}

/**
 * Helper: make a timed-out GET request to Kamino API, returns { status, data, raw, error }
 */
async function kaminoGet(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch (_) {}
    return { status: res.status, ok: res.ok, data, raw: raw.slice(0, 300) };
  } catch (e) {
    clearTimeout(timer);
    return { status: 0, ok: false, data: null, raw: "", error: e.message };
  }
}

async function fetchKaminoBalances() {
  const address = process.env.SOLANA_ADDRESS;
  if (!address || address === "YourSolanaPublicKey") {
    console.log("[Kamino] Skipped — no Solana address configured");
    return [];
  }

  // ── Primary: On-chain kToken detection + staked farm positions ──
  try {
    const holdings = await fetchKaminoViaOnChain(address);
    if (holdings.length > 0) {
      console.log(`[Kamino] ✓ Found ${holdings.length} position(s) via on-chain detection`);
    }

    // Also check for kTokens staked in Kamino farms
    try {
      const strategiesMap = await getKaminoStrategiesMap();
      if (strategiesMap) {
        const solPriceForFarm = await getSolPrice();
        const stakedHoldings = await fetchKaminoStakedPositions(address, strategiesMap, solPriceForFarm);
        if (stakedHoldings.length > 0) {
          console.log(`[Kamino] ✓ Found ${stakedHoldings.length} staked farm position(s)`);
          holdings.push(...stakedHoldings);
        }
      }
    } catch (farmErr) {
      console.warn(`[Kamino] Farm detection failed: ${farmErr.message}`);
    }

    if (holdings.length > 0) return holdings;
  } catch (err) {
    console.warn(`[Kamino] On-chain detection failed: ${err.message}`);
  }

  // ── Fallback: REST API endpoints (in case they start working) ──
  const liquidityEndpoints = [
    `https://api.kamino.finance/v2/users/${address}/strategies/shares`,
    `https://api.kamino.finance/v2/users/${address}/shares`,
    `https://api.kamino.finance/v2/users/${address}/kamino-earn`,
    `https://api.kamino.finance/v2/users/${address}/liquidity-positions`,
  ];

  for (const url of liquidityEndpoints) {
    const shortName = url.replace(`https://api.kamino.finance`, "").replace(address, "{wallet}");
    const { status, ok, data, raw, error } = await kaminoGet(url);

    if (error) {
      console.log(`[Kamino] ${shortName} → ERROR: ${error.slice(0, 60)}`);
      continue;
    }

    console.log(`[Kamino] ${shortName} → HTTP ${status}`);

    if (!ok || !data) continue;

    const holdings = parseKaminoLiquidityResponse(data, shortName);
    if (holdings.length > 0) {
      console.log(`[Kamino] ✓ Found ${holdings.length} liquidity position(s) via REST`);
      return holdings;
    }
  }

  console.log("[Kamino] No positions found via any method.");
  return [];
}

/**
 * Parse Kamino liquidity vault API responses (if REST endpoints work in future).
 */
function parseKaminoLiquidityResponse(data, source) {
  const holdings = [];

  const rows = Array.isArray(data) ? data : (data.data || data.strategies || data.vaults || data.shares || []);
  if (!Array.isArray(rows) || rows.length === 0) return holdings;

  for (const pos of rows) {
    const usdValue = parseFloat(
      pos.usdValue || pos.positionValueUsd || pos.tvl || pos.value || 0
    );

    if (usdValue > 0) {
      const nameA = pos.tokenAName || pos.tokenA?.symbol || pos.symbolA || pos.strategy?.tokenAName || "";
      const nameB = pos.tokenBName || pos.tokenB?.symbol || pos.symbolB || pos.strategy?.tokenBName || "";
      const label = nameA && nameB ? `${nameA}-${nameB}` : (pos.strategyName || pos.name || "kToken");

      console.log(`[Kamino] Vault ${label}: $${usdValue.toFixed(2)}`);
      holdings.push({ coin: "USDC", amount: usdValue, label: `Kamino LP (${label})` });
      continue;
    }

    const amtA = parseFloat(pos.tokenAAmounts || pos.tokenAAmount || pos.amountA || 0);
    const amtB = parseFloat(pos.tokenBAmounts || pos.tokenBAmount || pos.amountB || 0);
    const symA = (pos.tokenAName || pos.tokenA?.symbol || pos.symbolA || "").toUpperCase();
    const symB = (pos.tokenBName || pos.tokenB?.symbol || pos.symbolB || "").toUpperCase();

    if (amtA > 0 && symA) holdings.push({ coin: symA, amount: amtA });
    if (amtB > 0 && symB) holdings.push({ coin: symB, amount: amtB });
  }

  return holdings;
}

module.exports = {
  fetchPhantomBalances,
  fetchKaminoBalances,
};
