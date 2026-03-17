/**
 * EVM Connectors — Metamask (Ethereum) + PancakeSwap (Monad)
 * Queries native balances, ERC20 token balances, and PancakeSwap V3 LP positions.
 *
 * PancakeSwap LP pool is on MONAD chain (chain ID 143, RPC: rpc.monad.xyz).
 * Metamask tracks ETH mainnet.
 */
const { ethers } = require("ethers");
const fetch = require("node-fetch");

// Known token contracts — Ethereum Mainnet
const ETH_TOKENS = {
  "0xdAC17F958D2ee523a2206206994597C13D831ec7": { symbol: "USDT", decimals: 6 },
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": { symbol: "USDC", decimals: 6 },
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": { symbol: "DAI", decimals: 18 },
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": { symbol: "WBTC", decimals: 8 },
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": { symbol: "WETH", decimals: 18 },
  "0x514910771AF9Ca656af840dff83E8264EcF986CA": { symbol: "LINK", decimals: 18 },
  "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984": { symbol: "UNI", decimals: 18 },
  "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9": { symbol: "AAVE", decimals: 18 },
  "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0": { symbol: "MATIC", decimals: 18 },
  "0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1": { symbol: "ARB", decimals: 18 },
  "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE": { symbol: "SHIB", decimals: 18 },
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// ─── PancakeSwap V3 on Monad ────────────────────────────────────
// PancakeSwap deploys the same contract addresses across EVM chains via CREATE2.
const MONAD_RPC = "https://rpc.monad.xyz";
const PANCAKE_V3_POSITION_MANAGER = "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364";
const PANCAKE_V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";

const POSITION_MANAGER_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
];

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
];

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
];

// Known Monad token addresses (for resolving LP pair symbols)
const MONAD_TOKEN_RESOLVER = {
  // Native wrapped MON
  "0x760afe86e5de5fa0ee542fc7b7b713e1c5425701": { symbol: "WMON", decimals: 18 },
  // USDC on Monad
  "0xb2f82d0f38dc453d596ad40a37799446cc89274a": { symbol: "USDC", decimals: 6 },
  // USDT on Monad
  "0x88b8e2161dedc77ef4ab7585569d2415a1c1055d": { symbol: "USDT", decimals: 6 },
  // MON token
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee": { symbol: "MON", decimals: 18 },
  // LP pair tokens (from PancakeSwap V3 position #28038 diagnostic)
  "0x3bd359c1119da7da1d913d1c4d2b7c461115433a": { symbol: "WMON", decimals: 18 },
  "0x754704bc059f8c67012fed69bc8a327a5aafb603": { symbol: "USDC", decimals: 6 },
};

async function fetchTokenBalances(provider, address, tokenList, chainName) {
  const holdings = [];
  const promises = Object.entries(tokenList).map(async ([contractAddr, info]) => {
    try {
      const contract = new ethers.Contract(contractAddr, ERC20_ABI, provider);
      const rawBalance = await contract.balanceOf(address);
      const balance = parseFloat(ethers.formatUnits(rawBalance, info.decimals));
      if (balance > 0.001) {
        return { coin: info.symbol, amount: balance };
      }
    } catch (e) {
      // Token might not exist or contract call failed
    }
    return null;
  });

  const results = await Promise.allSettled(promises);
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      holdings.push(result.value);
    }
  }
  return holdings;
}

async function resolveTokenInfo(provider, tokenAddress) {
  // Check known Monad tokens first (all keys stored lowercase)
  const known = MONAD_TOKEN_RESOLVER[tokenAddress.toLowerCase()];
  if (known) return known;

  // Query the contract directly
  try {
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const [symbol, decimals] = await Promise.all([
      contract.symbol(),
      contract.decimals(),
    ]);
    const resolved = { symbol, decimals: Number(decimals) };
    // Cache for future lookups
    MONAD_TOKEN_RESOLVER[tokenAddress.toLowerCase()] = resolved;
    console.log(`[PancakeSwap] Resolved token ${tokenAddress.slice(0, 10)}... → ${symbol} (${decimals} decimals)`);
    return resolved;
  } catch (e) {
    return { symbol: `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`, decimals: 18 };
  }
}

/**
 * Estimate token amounts for a Uniswap V3 / PancakeSwap V3 position.
 */
function estimateV3PositionAmounts(sqrtPriceX96, tickLower, tickUpper, liquidity) {
  // Use floating-point math to avoid BigInt mixing issues.
  // Precision is sufficient for portfolio display purposes.
  const Q96 = 2 ** 96;

  const tl = Number(tickLower);
  const tu = Number(tickUpper);
  const liq = Number(liquidity.toString());

  const sqrtA = Math.sqrt(1.0001 ** tl) * Q96;
  const sqrtB = Math.sqrt(1.0001 ** tu) * Q96;
  const sqrtPrice = Number(sqrtPriceX96.toString());

  let amount0 = 0;
  let amount1 = 0;

  if (sqrtPrice <= sqrtA) {
    // Price below range — all token0
    amount0 = liq * (sqrtB - sqrtA) / (sqrtA * sqrtB / Q96);
  } else if (sqrtPrice >= sqrtB) {
    // Price above range — all token1
    amount1 = liq * (sqrtB - sqrtA) / Q96;
  } else {
    // Price in range — mix of both
    amount0 = liq * (sqrtB - sqrtPrice) / (sqrtPrice * sqrtB / Q96);
    amount1 = liq * (sqrtPrice - sqrtA) / Q96;
  }

  // Return as BigInt for compatibility with ethers.formatUnits()
  return {
    amount0: BigInt(Math.max(0, Math.floor(amount0))),
    amount1: BigInt(Math.max(0, Math.floor(amount1))),
  };
}

/**
 * Fetch PancakeSwap V3 LP positions on MONAD chain.
 */
async function fetchPancakeV3Positions(provider, address) {
  const holdings = [];

  try {
    const positionManager = new ethers.Contract(
      PANCAKE_V3_POSITION_MANAGER,
      POSITION_MANAGER_ABI,
      provider
    );

    const factory = new ethers.Contract(PANCAKE_V3_FACTORY, FACTORY_ABI, provider);

    // How many NFT positions does this address own?
    const nftBalance = await positionManager.balanceOf(address);
    const count = Number(nftBalance);

    if (count === 0) {
      console.log("[PancakeSwap V3] No LP positions found on Monad");
      return holdings;
    }

    console.log(`[PancakeSwap V3] Found ${count} LP position(s) on Monad, resolving...`);

    for (let i = 0; i < count; i++) {
      try {
        const tokenId = await positionManager.tokenOfOwnerByIndex(address, i);
        const position = await positionManager.positions(tokenId);

        const { token0, token1, fee, tickLower, tickUpper, liquidity } = position;

        // Skip closed positions (zero liquidity)
        if (liquidity === 0n) {
          console.log(`[PancakeSwap V3] Position #${tokenId}: closed (0 liquidity), skipping`);
          continue;
        }

        // Resolve token info
        const [info0, info1] = await Promise.all([
          resolveTokenInfo(provider, token0),
          resolveTokenInfo(provider, token1),
        ]);

        // Get current pool price
        try {
          const poolAddress = await factory.getPool(token0, token1, fee);
          if (poolAddress === ethers.ZeroAddress) {
            console.warn(`[PancakeSwap V3] Pool not found for ${info0.symbol}/${info1.symbol}`);
            continue;
          }

          const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
          const slot0 = await pool.slot0();
          const sqrtPriceX96 = slot0[0];

          const { amount0, amount1 } = estimateV3PositionAmounts(
            sqrtPriceX96, tickLower, tickUpper, liquidity
          );

          const amt0 = parseFloat(ethers.formatUnits(amount0, info0.decimals));
          const amt1 = parseFloat(ethers.formatUnits(amount1, info1.decimals));

          console.log(`[PancakeSwap V3] Position #${tokenId}: ${amt0.toFixed(4)} ${info0.symbol} + ${amt1.toFixed(4)} ${info1.symbol}`);

          if (amt0 > 0.0001) {
            holdings.push({ coin: info0.symbol, amount: amt0, source: `LP:${info0.symbol}/${info1.symbol}` });
          }
          if (amt1 > 0.0001) {
            holdings.push({ coin: info1.symbol, amount: amt1, source: `LP:${info0.symbol}/${info1.symbol}` });
          }
        } catch (poolErr) {
          console.warn(`[PancakeSwap V3] Could not read pool for position #${tokenId}:`, poolErr.message);
        }
      } catch (posErr) {
        console.warn(`[PancakeSwap V3] Could not read position ${i}:`, posErr.message);
      }
    }

    console.log(`[PancakeSwap V3] Resolved ${holdings.length} assets from LP positions`);
  } catch (err) {
    console.warn("[PancakeSwap V3] LP detection error:", err.message);
  }

  return holdings;
}

// ─── Metamask (Ethereum Mainnet) ────────────────────────────────

async function fetchMetamaskBalances() {
  const address = process.env.ETH_ADDRESS;
  if (!address || address === "0xYourEthereumAddress") {
    console.log("[Metamask] Skipped — no ETH address configured");
    return [];
  }

  try {
    // Try multiple RPC endpoints for reliability
    const ETH_RPCS = [
      "https://eth.llamarpc.com",
      "https://rpc.ankr.com/eth",
      "https://ethereum-rpc.publicnode.com",
    ];
    let provider;
    for (const rpc of ETH_RPCS) {
      try {
        const p = new ethers.JsonRpcProvider(rpc);
        await p.getBlockNumber(); // quick connectivity test
        provider = p;
        break;
      } catch (_) {
        console.warn(`[Metamask] RPC ${rpc} unreachable, trying next...`);
      }
    }
    if (!provider) {
      console.error("[Metamask] All Ethereum RPCs failed");
      return [];
    }
    const holdings = [];

    // 1. Native ETH balance
    const ethBalance = await provider.getBalance(address);
    const ethAmount = parseFloat(ethers.formatEther(ethBalance));
    if (ethAmount > 0.0001) {
      holdings.push({ coin: "ETH", amount: ethAmount });
    }

    // 2. Known ERC20 tokens
    const tokenHoldings = await fetchTokenBalances(provider, address, ETH_TOKENS, "Ethereum");
    holdings.push(...tokenHoldings);

    // 3. If Etherscan key is available, also check tokens from tx history
    if (process.env.ETHERSCAN_API_KEY && process.env.ETHERSCAN_API_KEY !== "your_etherscan_api_key") {
      try {
        const url = `https://api.etherscan.io/api?module=account&action=tokentx&address=${address}&page=1&offset=100&sort=desc&apikey=${process.env.ETHERSCAN_API_KEY}`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          if (data.status === "1" && data.result) {
            const seen = new Set();
            for (const tx of data.result) {
              if (!seen.has(tx.contractAddress) && !ETH_TOKENS[tx.contractAddress] && !holdings.some(h => h.coin === tx.tokenSymbol)) {
                seen.add(tx.contractAddress);
                try {
                  const contract = new ethers.Contract(tx.contractAddress, ERC20_ABI, provider);
                  const rawBalance = await contract.balanceOf(address);
                  const balance = parseFloat(ethers.formatUnits(rawBalance, parseInt(tx.tokenDecimal)));
                  if (balance > 0.001) {
                    holdings.push({ coin: tx.tokenSymbol, amount: balance });
                  }
                } catch (e) { /* skip */ }
              }
            }
          }
        }
      } catch (e) { /* Etherscan lookup failed */ }
    }

    console.log(`[Metamask] Fetched ${holdings.length} assets`);
    return holdings;
  } catch (err) {
    console.error("[Metamask] Error:", err.message);
    return [];
  }
}

// ─── PancakeSwap (Monad Chain) ──────────────────────────────────

async function fetchPancakeSwapBalances() {
  // Use ETH_ADDRESS on Monad — same address, different chain
  const address = process.env.BSC_ADDRESS || process.env.ETH_ADDRESS;
  if (!address || address === "0xYourBscAddress" || address === "0xYourEthereumAddress") {
    console.log("[PancakeSwap] Skipped — no address configured");
    return [];
  }

  try {
    console.log(`[PancakeSwap] Connecting to Monad chain (${MONAD_RPC})...`);
    const provider = new ethers.JsonRpcProvider(MONAD_RPC);
    const holdings = [];

    // 1. Native MON balance on Monad
    try {
      const monBalance = await provider.getBalance(address);
      const monAmount = parseFloat(ethers.formatEther(monBalance));
      if (monAmount > 0.0001) {
        holdings.push({ coin: "MON", amount: monAmount });
        console.log(`[PancakeSwap] Native MON: ${monAmount.toFixed(4)}`);
      }
    } catch (e) {
      console.warn("[PancakeSwap] Could not fetch MON balance:", e.message);
    }

    // 2. PancakeSwap V3 LP positions on Monad (MON/USDC, etc.)
    const lpHoldings = await fetchPancakeV3Positions(provider, address);
    for (const lp of lpHoldings) {
      const existing = holdings.find(h => h.coin === lp.coin);
      if (existing) {
        existing.amount += lp.amount;
      } else {
        holdings.push({ coin: lp.coin, amount: lp.amount });
      }
    }

    console.log(`[PancakeSwap] Fetched ${holdings.length} assets on Monad (including LP positions)`);
    return holdings;
  } catch (err) {
    console.error("[PancakeSwap] Error:", err.message);
    return [];
  }
}

module.exports = {
  fetchMetamaskBalances,
  fetchPancakeSwapBalances,
};
