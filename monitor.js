#!/usr/bin/env node
"use strict";

const https = require("https");
const http = require("http");

// ─── ANSI helpers ───────────────────────────────────────────────────────────
const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const WHITE = `${ESC}37m`;
const BG_GREEN = `${ESC}42m`;
const BG_YELLOW = `${ESC}43m`;
const BG_RED = `${ESC}41m`;
const BRIGHT_WHITE = `${ESC}97m`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const CLEAR_SCREEN = `${ESC}2J${ESC}H`;

// ─── HTTP fetch helper (no dependencies) ────────────────────────────────────
function fetch(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location, timeout).then(resolve, reject);
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`JSON parse error for ${url}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

// ─── Data sources ───────────────────────────────────────────────────────────

// Binance: all USDT pairs (public, no key needed)
async function getBinancePrices() {
  const data = await fetch("https://api.binance.com/api/v3/ticker/price");
  const map = {};
  for (const item of data) {
    if (item.symbol.endsWith("USDT")) {
      const base = item.symbol.replace("USDT", "");
      map[base] = parseFloat(item.price);
    }
  }
  return map;
}

// Jupiter Aggregator price API — covers both Raydium & Orca pools on Solana
// Public, no key needed. Returns prices in USDT terms.
async function getDexPrices(symbols) {
  // Jupiter uses coin-gecko IDs or token mints. We'll use their price API v2
  // which accepts token symbols via the "ids" param (comma separated).
  // For simplicity, we use the CoinGecko simple/price endpoint which is free
  // and covers most tokens with Raydium/Orca data.

  // Map of common symbols to coingecko IDs
  const results = {};

  // Use Jupiter's public token price endpoint (Solana DEX aggregator)
  // This covers Raydium + Orca liquidity
  try {
    const jupData = await fetch(
      "https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112"
    );
    // Jupiter needs token mint addresses — we'll use a different approach
  } catch {}

  return results;
}

// ─── Token registry: map symbols to Solana mint addresses ───────────────────
// We fetch Jupiter's full token list and build a symbol→mint map
let TOKEN_MINT_MAP = {};
let TOKEN_LIST_LOADED = false;

async function loadTokenList() {
  try {
    // Jupiter strict token list (verified tokens only)
    const tokens = await fetch("https://tokens.jup.ag/tokens?tags=verified", 15000);
    for (const t of tokens) {
      const sym = t.symbol.toUpperCase();
      // Prefer tokens with higher daily volume / known addresses
      if (!TOKEN_MINT_MAP[sym] || t.daily_volume > (TOKEN_MINT_MAP[sym].daily_volume || 0)) {
        TOKEN_MINT_MAP[sym] = {
          mint: t.address,
          name: t.name,
          decimals: t.decimals,
          daily_volume: t.daily_volume || 0,
        };
      }
    }
    TOKEN_LIST_LOADED = true;
  } catch (e) {
    console.error("Failed to load Jupiter token list:", e.message);
  }
}

// USDT and USDC mints on Solana
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Fetch DEX prices from Jupiter for a batch of mints
async function getJupiterPrices(mints) {
  if (mints.length === 0) return {};
  // Jupiter price API v2 — public, no key
  // Batch up to 100 at a time
  const results = {};
  const batchSize = 100;

  for (let i = 0; i < mints.length; i += batchSize) {
    const batch = mints.slice(i, i + batchSize);
    const ids = batch.join(",");
    try {
      const data = await fetch(
        `https://api.jup.ag/price/v2?ids=${ids}&vsToken=${USDC_MINT}`,
        8000
      );
      if (data && data.data) {
        for (const [mint, info] of Object.entries(data.data)) {
          if (info && info.price) {
            results[mint] = parseFloat(info.price);
          }
        }
      }
    } catch {}
  }
  return results;
}

// ─── Pool liquidity from DexScreener (public, no key) ──────────────────────
let liquidityCache = {};
let lastLiquidityFetch = 0;

async function getDexScreenerLiquidity(symbols) {
  // Rate-limit: refresh every 10 seconds
  const now = Date.now();
  if (now - lastLiquidityFetch < 10000 && Object.keys(liquidityCache).length > 0) {
    return liquidityCache;
  }

  const results = {};
  // DexScreener search API — fetch in batches of 5 symbols
  const batchSize = 5;
  const toFetch = symbols.slice(0, 60); // limit to top 60

  const promises = [];
  for (let i = 0; i < toFetch.length; i += batchSize) {
    const batch = toFetch.slice(i, i + batchSize);
    for (const sym of batch) {
      promises.push(
        fetch(`https://api.dexscreener.com/latest/dex/search?q=${sym}%20USDT%20solana`, 5000)
          .then((data) => {
            if (data && data.pairs) {
              // Find best Solana pair (Raydium or Orca)
              const solanaPairs = data.pairs.filter(
                (p) =>
                  p.chainId === "solana" &&
                  (p.dexId === "raydium" || p.dexId === "orca") &&
                  (p.quoteToken?.symbol === "USDT" ||
                    p.quoteToken?.symbol === "USDC" ||
                    p.baseToken?.symbol === sym)
              );
              if (solanaPairs.length > 0) {
                // Pick the one with highest liquidity
                solanaPairs.sort(
                  (a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
                );
                const best = solanaPairs[0];
                results[sym] = {
                  liquidity: best.liquidity?.usd || 0,
                  dex: best.dexId,
                  price: parseFloat(best.priceUsd) || 0,
                  pairAddress: best.pairAddress,
                };
              }
            }
          })
          .catch(() => {})
      );
    }
    // Small delay between batches to avoid rate limits
    if (i + batchSize < toFetch.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  await Promise.all(promises);
  liquidityCache = { ...liquidityCache, ...results };
  lastLiquidityFetch = Date.now();
  return liquidityCache;
}

// ─── Terminal table rendering ───────────────────────────────────────────────

function formatPrice(price) {
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.001) return price.toFixed(6);
  return price.toFixed(8);
}

function formatUSD(amount) {
  if (amount >= 1e9) return `$${(amount / 1e9).toFixed(2)}B`;
  if (amount >= 1e6) return `$${(amount / 1e6).toFixed(2)}M`;
  if (amount >= 1e3) return `$${(amount / 1e3).toFixed(1)}K`;
  return `$${amount.toFixed(0)}`;
}

function padRight(str, len) {
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, "");
  return str + " ".repeat(Math.max(0, len - stripped.length));
}

function padLeft(str, len) {
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, "");
  return " ".repeat(Math.max(0, len - stripped.length)) + str;
}

function renderTable(rows, lastUpdate, matchCount, totalBinance, errorMsg) {
  const cols = process.stdout.columns || 120;
  const termRows = process.stdout.rows || 40;

  let output = CLEAR_SCREEN;

  // Header
  const title = `${BOLD}${CYAN} BINANCE vs DEX (Raydium/Orca) — Fiyat Farki Monitoru ${RESET}`;
  output += title + "\n";
  output += `${DIM}${WHITE} Binance USDT Pariteleri: ${totalBinance} | Eslesen DEX Coinleri: ${matchCount} | Son Guncelleme: ${lastUpdate}${RESET}\n`;
  if (errorMsg) {
    output += `${RED} ${errorMsg}${RESET}\n`;
  }
  output +=
    `${DIM}${"─".repeat(Math.min(cols, 120))}${RESET}\n`;

  // Column headers
  const hCoin = padRight(`${BOLD} COIN`, 10);
  const hDex = padRight("DEX", 9);
  const hBinance = padLeft("BINANCE($)", 14);
  const hDexP = padLeft("DEX($)", 14);
  const hDiff = padLeft("FARK($)", 13);
  const hPct = padLeft("FARK(%)", 10);
  const hLiq = padLeft("LIKIDITE", 12);
  const hSignal = padRight(" SINYAL", 10);
  output += `${BOLD}${WHITE}${hCoin} ${hDex} ${hBinance} ${hDexP} ${hDiff} ${hPct} ${hLiq} ${hSignal}${RESET}\n`;
  output += `${DIM}${"─".repeat(Math.min(cols, 120))}${RESET}\n`;

  // Data rows
  const maxRows = termRows - 8;
  const displayRows = rows.slice(0, maxRows);

  for (const row of displayRows) {
    const isHighlight = Math.abs(row.pctDiff) > 0.15 && row.liquidity > 500000;
    const bg = isHighlight ? BG_GREEN : "";
    const fg = isHighlight ? `${BRIGHT_WHITE}${BOLD}` : WHITE;
    const resetRow = isHighlight ? RESET : RESET;

    const pctColor =
      row.pctDiff > 0.15
        ? GREEN
        : row.pctDiff < -0.15
        ? RED
        : YELLOW;

    const coin = padRight(` ${row.symbol}`, 10);
    const dex = padRight(row.dex.toUpperCase(), 9);
    const binP = padLeft(formatPrice(row.binancePrice), 14);
    const dexP = padLeft(formatPrice(row.dexPrice), 14);
    const diff = padLeft(
      (row.diff >= 0 ? "+" : "") + formatPrice(Math.abs(row.diff)),
      13
    );
    const pct = padLeft(
      (row.pctDiff >= 0 ? "+" : "") + row.pctDiff.toFixed(3) + "%",
      10
    );
    const liq = padLeft(formatUSD(row.liquidity), 12);

    let signal = "";
    if (isHighlight) {
      signal = row.pctDiff > 0 ? " >> ARB!  " : " << ARB!  ";
    } else if (Math.abs(row.pctDiff) > 0.15) {
      signal = " ~ dusuk liq";
    } else {
      signal = "          ";
    }

    if (isHighlight) {
      output += `${bg}${BRIGHT_WHITE}${BOLD}${coin} ${dex} ${binP} ${dexP} ${diff} ${pct} ${liq} ${signal}${RESET}\n`;
    } else {
      output += `${fg}${coin} ${dex} ${binP} ${dexP} ${diff} ${pctColor}${pct}${RESET} ${fg}${liq} ${signal}${RESET}\n`;
    }
  }

  if (rows.length > maxRows) {
    output += `${DIM} ... ve ${rows.length - maxRows} coin daha (terminal buyutun)${RESET}\n`;
  }

  // Footer
  output += `${DIM}${"─".repeat(Math.min(cols, 120))}${RESET}\n`;
  output += `${DIM} [Ctrl+C] Cikis | Yesil satirlar: fark>%0.15 & likidite>$500K | 3sn aralikla guncellenir${RESET}\n`;

  process.stdout.write(output);
}

// ─── Main loop ──────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write(HIDE_CURSOR);
  process.on("exit", () => process.stdout.write(SHOW_CURSOR));
  process.on("SIGINT", () => {
    process.stdout.write(SHOW_CURSOR);
    process.stdout.write(`\n${CYAN}Monitör kapatıldı.${RESET}\n`);
    process.exit(0);
  });

  process.stdout.write(
    `${CLEAR_SCREEN}${CYAN}${BOLD} Jupiter token listesi yukleniyor...${RESET}\n`
  );
  await loadTokenList();
  process.stdout.write(
    `${GREEN} ${Object.keys(TOKEN_MINT_MAP).length} token yuklendi. Baslaniyor...${RESET}\n`
  );

  let errorMsg = "";

  async function tick() {
    try {
      // 1) Get Binance prices
      const binancePrices = await getBinancePrices();
      const binanceSymbols = Object.keys(binancePrices);

      // 2) Find matching tokens that exist on Jupiter (Solana DEXes)
      const matchedSymbols = binanceSymbols.filter((s) => TOKEN_MINT_MAP[s]);
      const mints = matchedSymbols.map((s) => TOKEN_MINT_MAP[s].mint);

      // 3) Get Jupiter DEX prices
      const jupPrices = await getJupiterPrices(mints);

      // 4) Build mint→symbol reverse map
      const mintToSymbol = {};
      for (const sym of matchedSymbols) {
        mintToSymbol[TOKEN_MINT_MAP[sym].mint] = sym;
      }

      // 5) Get DexScreener liquidity for tokens that have price data
      const symbolsWithPrice = [];
      for (const [mint, price] of Object.entries(jupPrices)) {
        if (mintToSymbol[mint]) {
          symbolsWithPrice.push(mintToSymbol[mint]);
        }
      }

      const liquidity = await getDexScreenerLiquidity(symbolsWithPrice);

      // 6) Build rows
      const rows = [];
      for (const [mint, dexPrice] of Object.entries(jupPrices)) {
        const sym = mintToSymbol[mint];
        if (!sym || !binancePrices[sym]) continue;

        const binPrice = binancePrices[sym];
        const diff = dexPrice - binPrice;
        const pctDiff = (diff / binPrice) * 100;
        const liqData = liquidity[sym];

        rows.push({
          symbol: sym,
          binancePrice: binPrice,
          dexPrice: dexPrice,
          diff: diff,
          pctDiff: pctDiff,
          liquidity: liqData ? liqData.liquidity : 0,
          dex: liqData ? liqData.dex : "raydium",
        });
      }

      // Sort: highlighted rows first, then by absolute pct diff descending
      rows.sort((a, b) => {
        const aHighlight =
          Math.abs(a.pctDiff) > 0.15 && a.liquidity > 500000 ? 1 : 0;
        const bHighlight =
          Math.abs(b.pctDiff) > 0.15 && b.liquidity > 500000 ? 1 : 0;
        if (bHighlight !== aHighlight) return bHighlight - aHighlight;
        return Math.abs(b.pctDiff) - Math.abs(a.pctDiff);
      });

      const now = new Date().toLocaleTimeString("tr-TR");
      renderTable(rows, now, matchedSymbols.length, binanceSymbols.length, errorMsg);
      errorMsg = "";
    } catch (e) {
      errorMsg = `Hata: ${e.message}`;
    }
  }

  // Initial tick
  await tick();

  // Repeat every 3 seconds
  setInterval(tick, 3000);
}

main().catch((e) => {
  process.stdout.write(SHOW_CURSOR);
  console.error("Fatal:", e);
  process.exit(1);
});
