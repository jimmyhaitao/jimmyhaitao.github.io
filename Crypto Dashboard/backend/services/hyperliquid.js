/**
 * Hyperliquid Connector
 * Uses Hyperliquid's public info API to query spot, perp, and HLP vault balances.
 * Requires an EVM (HyperCore) address.
 */
const fetch = require("node-fetch");

const API_URL = "https://api.hyperliquid.xyz/info";

/**
 * Helper to POST to Hyperliquid info API
 */
async function hlPost(body) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Hyperliquid API ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return res.json();
}

async function fetchHyperliquidBalances() {
  const address = process.env.HYPERLIQUID_ADDRESS;
  if (!address || address === "0xYourHyperliquidAddress") {
    console.log("[Hyperliquid] Skipped — no address configured");
    return [];
  }

  const holdings = [];

  try {
    // 1. Fetch spot balances
    try {
      const spotData = await hlPost({
        type: "spotClearinghouseState",
        user: address,
      });

      if (spotData.balances) {
        for (const bal of spotData.balances) {
          const amount = parseFloat(bal.total || bal.hold || 0);
          if (amount > 0 && bal.coin) {
            holdings.push({
              coin: bal.coin.toUpperCase(),
              amount,
            });
          }
        }
      }
      console.log(`[Hyperliquid] Spot: ${holdings.length} assets`);
    } catch (e) {
      console.warn("[Hyperliquid] Spot query failed:", e.message);
    }

    // 2. Fetch perp account state (margin balances)
    try {
      const perpData = await hlPost({
        type: "clearinghouseState",
        user: address,
      });

      if (perpData.marginSummary) {
        const accountValue = parseFloat(perpData.marginSummary.accountValue || 0);
        if (accountValue > 0) {
          // Perp margin is held in USDC on Hyperliquid
          const existingUSDC = holdings.find(h => h.coin === "USDC");
          if (existingUSDC) {
            existingUSDC.amount += accountValue;
          } else {
            holdings.push({ coin: "USDC", amount: accountValue });
          }
          console.log(`[Hyperliquid] Perp margin: $${accountValue.toFixed(2)}`);
        }
      }

      // Log open perp positions for info
      if (perpData.assetPositions) {
        const openPositions = perpData.assetPositions.filter(
          p => p.position && parseFloat(p.position.szi) !== 0
        );
        if (openPositions.length > 0) {
          console.log(`[Hyperliquid] ${openPositions.length} open perp position(s)`);
        }
      }
    } catch (e) {
      console.warn("[Hyperliquid] Perp query failed:", e.message);
    }

    // 3. Fetch HLP vault equity — this captures deposits into the HLP vault
    try {
      const vaultEquities = await hlPost({
        type: "userVaultEquities",
        user: address,
      });

      if (Array.isArray(vaultEquities) && vaultEquities.length > 0) {
        let totalVaultEquity = 0;
        for (const vault of vaultEquities) {
          const equity = parseFloat(vault.equity || 0);
          if (equity > 0) {
            totalVaultEquity += equity;
            const vaultName = vault.vaultName || vault.vault || "Unknown Vault";
            console.log(`[Hyperliquid] Vault "${vaultName}": $${equity.toFixed(2)}`);
          }
        }

        if (totalVaultEquity > 0) {
          // HLP vault equity is denominated in USDC
          const existingUSDC = holdings.find(h => h.coin === "USDC");
          if (existingUSDC) {
            existingUSDC.amount += totalVaultEquity;
          } else {
            holdings.push({ coin: "USDC", amount: totalVaultEquity });
          }
          console.log(`[Hyperliquid] Total vault equity: $${totalVaultEquity.toFixed(2)}`);
        }
      }
    } catch (e) {
      // userVaultEquities might not be available or user has no vault deposits
      if (!e.message.includes("404") && !e.message.includes("not found")) {
        console.warn("[Hyperliquid] Vault query issue:", e.message);
      }
    }

    // 4. Fetch staked HYPE via delegatorSummary
    try {
      const stakingData = await hlPost({
        type: "delegatorSummary",
        user: address,
      });

      const delegated = parseFloat(stakingData?.delegated || 0);
      const undelegated = parseFloat(stakingData?.undelegated || 0);
      const totalStaked = delegated + undelegated;
      if (totalStaked > 0) {
        const existingHYPE = holdings.find(h => h.coin === "HYPE");
        if (existingHYPE) {
          existingHYPE.amount += totalStaked;
        } else {
          holdings.push({ coin: "HYPE", amount: totalStaked });
        }
        console.log(`[Hyperliquid] Staked: ${delegated.toFixed(2)} HYPE (+ ${undelegated.toFixed(2)} undelegating)`);
      }
    } catch (e) {
      console.warn("[Hyperliquid] Staking query failed:", e.message);
    }

    console.log(`[Hyperliquid] Fetched ${holdings.length} assets total`);
    return holdings;
  } catch (err) {
    console.error("[Hyperliquid] Error:", err.message);
    return [];
  }
}

module.exports = { fetchHyperliquidBalances };
