#!/bin/bash
# Marduk-Board kurulum scripti
# Bu scripti herhangi bir klasorde calistirin

set -e

echo ">>> Marduk-Board klonlaniyor..."
git clone https://github.com/memotur-droid/Marduk-Board.git
cd Marduk-Board

echo ">>> Dosyalar olusturuluyor..."

# .gitignore
cat > .gitignore << 'GITIGNORE'
node_modules/
.env
GITIGNORE

# package.json
cat > package.json << 'PKGJSON'
{
  "name": "marduk-board",
  "version": "1.0.0",
  "description": "Binance vs DEX (Raydium/Orca) gercek zamanli fiyat farki monitoru",
  "main": "monitor.js",
  "scripts": {
    "start": "node monitor.js"
  },
  "keywords": ["binance", "dex", "raydium", "orca", "arbitrage", "solana"],
  "license": "MIT",
  "dependencies": {}
}
PKGJSON

# monitor.js
cat > monitor.js << 'MONITORJS'
#!/usr/bin/env node
"use strict";

const https = require("https");
const http = require("http");

// --- ANSI helpers ---
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
const BRIGHT_WHITE = `${ESC}97m`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const CLEAR_SCREEN = `${ESC}2J${ESC}H`;

// --- HTTP fetch helper (zero dependencies) ---
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
          reject(new Error(`JSON parse error: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// --- Binance: all USDT pairs (public, no key) ---
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

// --- Token registry: Jupiter verified token list ---
let TOKEN_MINT_MAP = {};

async function loadTokenList() {
  try {
    const tokens = await fetch("https://tokens.jup.ag/tokens?tags=verified", 15000);
    for (const t of tokens) {
      const sym = t.symbol.toUpperCase();
      if (!TOKEN_MINT_MAP[sym] || t.daily_volume > (TOKEN_MINT_MAP[sym].daily_volume || 0)) {
        TOKEN_MINT_MAP[sym] = {
          mint: t.address,
          name: t.name,
          decimals: t.decimals,
          daily_volume: t.daily_volume || 0,
        };
      }
    }
  } catch (e) {
    console.error("Jupiter token listesi yuklenemedi:", e.message);
  }
}

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// --- Jupiter DEX prices (Raydium + Orca aggregated) ---
async function getJupiterPrices(mints) {
  if (mints.length === 0) return {};
  const results = {};
  const batchSize = 100;

  for (let i = 0; i < mints.length; i += batchSize) {
    const batch = mints.slice(i, i + batchSize);
    const ids = batch.join(",");
    try {
      const data = await fetch(
        `https://api.jup.ag/price/v2?ids=${ids}&vsToken=${USDC_MINT}`, 8000
      );
      if (data && data.data) {
        for (const [mint, info] of Object.entries(data.data)) {
          if (info && info.price) results[mint] = parseFloat(info.price);
        }
      }
    } catch {}
  }
  return results;
}

// --- DexScreener pool liquidity (public, no key) ---
let liquidityCache = {};
let lastLiquidityFetch = 0;

async function getDexScreenerLiquidity(symbols) {
  const now = Date.now();
  if (now - lastLiquidityFetch < 10000 && Object.keys(liquidityCache).length > 0) {
    return liquidityCache;
  }

  const results = {};
  const toFetch = symbols.slice(0, 60);
  const promises = [];

  for (let i = 0; i < toFetch.length; i += 5) {
    const batch = toFetch.slice(i, i + 5);
    for (const sym of batch) {
      promises.push(
        fetch(`https://api.dexscreener.com/latest/dex/search?q=${sym}%20USDT%20solana`, 5000)
          .then((data) => {
            if (data && data.pairs) {
              const solanaPairs = data.pairs.filter(
                (p) =>
                  p.chainId === "solana" &&
                  (p.dexId === "raydium" || p.dexId === "orca") &&
                  (p.quoteToken?.symbol === "USDT" ||
                    p.quoteToken?.symbol === "USDC" ||
                    p.baseToken?.symbol === sym)
              );
              if (solanaPairs.length > 0) {
                solanaPairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
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
    if (i + 5 < toFetch.length) await new Promise((r) => setTimeout(r, 200));
  }

  await Promise.all(promises);
  liquidityCache = { ...liquidityCache, ...results };
  lastLiquidityFetch = Date.now();
  return liquidityCache;
}

// --- Terminal table rendering ---

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
  const line = "\u2500".repeat(Math.min(cols, 120));

  let output = CLEAR_SCREEN;
  output += `${BOLD}${CYAN} BINANCE vs DEX (Raydium/Orca) \u2014 Marduk Board ${RESET}\n`;
  output += `${DIM}${WHITE} Binance USDT: ${totalBinance} | DEX Eslesen: ${matchCount} | ${lastUpdate}${RESET}\n`;
  if (errorMsg) output += `${RED} ${errorMsg}${RESET}\n`;
  output += `${DIM}${line}${RESET}\n`;

  const hCoin = padRight(`${BOLD} COIN`, 10);
  const hDex = padRight("DEX", 9);
  const hBin = padLeft("BINANCE($)", 14);
  const hDexP = padLeft("DEX($)", 14);
  const hDiff = padLeft("FARK($)", 13);
  const hPct = padLeft("FARK(%)", 10);
  const hLiq = padLeft("LIKIDITE", 12);
  const hSig = padRight(" SINYAL", 10);
  output += `${BOLD}${WHITE}${hCoin} ${hDex} ${hBin} ${hDexP} ${hDiff} ${hPct} ${hLiq} ${hSig}${RESET}\n`;
  output += `${DIM}${line}${RESET}\n`;

  const maxRows = termRows - 8;
  const displayRows = rows.slice(0, maxRows);

  for (const row of displayRows) {
    const isHighlight = Math.abs(row.pctDiff) > 0.15 && row.liquidity > 500000;
    const pctColor = row.pctDiff > 0.15 ? GREEN : row.pctDiff < -0.15 ? RED : YELLOW;
    const fg = isHighlight ? `${BRIGHT_WHITE}${BOLD}` : WHITE;

    const coin = padRight(` ${row.symbol}`, 10);
    const dex = padRight(row.dex.toUpperCase(), 9);
    const binP = padLeft(formatPrice(row.binancePrice), 14);
    const dexP = padLeft(formatPrice(row.dexPrice), 14);
    const diff = padLeft((row.diff >= 0 ? "+" : "") + formatPrice(Math.abs(row.diff)), 13);
    const pct = padLeft((row.pctDiff >= 0 ? "+" : "") + row.pctDiff.toFixed(3) + "%", 10);
    const liq = padLeft(formatUSD(row.liquidity), 12);

    let signal = "          ";
    if (isHighlight) signal = row.pctDiff > 0 ? " >> ARB!  " : " << ARB!  ";
    else if (Math.abs(row.pctDiff) > 0.15) signal = " ~ dusuk liq";

    if (isHighlight) {
      output += `${BG_GREEN}${BRIGHT_WHITE}${BOLD}${coin} ${dex} ${binP} ${dexP} ${diff} ${pct} ${liq} ${signal}${RESET}\n`;
    } else {
      output += `${fg}${coin} ${dex} ${binP} ${dexP} ${diff} ${pctColor}${pct}${RESET} ${fg}${liq} ${signal}${RESET}\n`;
    }
  }

  if (rows.length > maxRows) {
    output += `${DIM} ... ve ${rows.length - maxRows} coin daha${RESET}\n`;
  }

  output += `${DIM}${line}${RESET}\n`;
  output += `${DIM} [Ctrl+C] Cikis | Yesil: fark>%0.15 & likidite>$500K | 3sn guncelleme${RESET}\n`;
  process.stdout.write(output);
}

// --- Main loop ---

async function main() {
  process.stdout.write(HIDE_CURSOR);
  process.on("exit", () => process.stdout.write(SHOW_CURSOR));
  process.on("SIGINT", () => {
    process.stdout.write(SHOW_CURSOR);
    process.stdout.write(`\n${CYAN}Marduk Board kapatildi.${RESET}\n`);
    process.exit(0);
  });

  process.stdout.write(`${CLEAR_SCREEN}${CYAN}${BOLD} Jupiter token listesi yukleniyor...${RESET}\n`);
  await loadTokenList();
  process.stdout.write(`${GREEN} ${Object.keys(TOKEN_MINT_MAP).length} token yuklendi.${RESET}\n`);

  let errorMsg = "";

  async function tick() {
    try {
      const binancePrices = await getBinancePrices();
      const binanceSymbols = Object.keys(binancePrices);
      const matchedSymbols = binanceSymbols.filter((s) => TOKEN_MINT_MAP[s]);
      const mints = matchedSymbols.map((s) => TOKEN_MINT_MAP[s].mint);
      const jupPrices = await getJupiterPrices(mints);

      const mintToSymbol = {};
      for (const sym of matchedSymbols) mintToSymbol[TOKEN_MINT_MAP[sym].mint] = sym;

      const symbolsWithPrice = [];
      for (const [mint] of Object.entries(jupPrices)) {
        if (mintToSymbol[mint]) symbolsWithPrice.push(mintToSymbol[mint]);
      }

      const liquidity = await getDexScreenerLiquidity(symbolsWithPrice);

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
          diff, pctDiff,
          liquidity: liqData ? liqData.liquidity : 0,
          dex: liqData ? liqData.dex : "raydium",
        });
      }

      rows.sort((a, b) => {
        const aH = Math.abs(a.pctDiff) > 0.15 && a.liquidity > 500000 ? 1 : 0;
        const bH = Math.abs(b.pctDiff) > 0.15 && b.liquidity > 500000 ? 1 : 0;
        if (bH !== aH) return bH - aH;
        return Math.abs(b.pctDiff) - Math.abs(a.pctDiff);
      });

      const now = new Date().toLocaleTimeString("tr-TR");
      renderTable(rows, now, matchedSymbols.length, binanceSymbols.length, errorMsg);
      errorMsg = "";
    } catch (e) {
      errorMsg = `Hata: ${e.message}`;
    }
  }

  await tick();
  setInterval(tick, 3000);
}

main().catch((e) => {
  process.stdout.write(SHOW_CURSOR);
  console.error("Fatal:", e);
  process.exit(1);
});
MONITORJS

# README guncelle
cat > README.md << 'README'
# Marduk Board

Binance vs DEX (Raydium/Orca) gercek zamanli fiyat farki monitoru.

## Ozellikler

- Binance tum USDT paritelerini cekar (public API)
- Jupiter ile Solana DEX (Raydium + Orca) fiyat eslesmeleri
- DexScreener ile havuz likiditesi
- Terminal tablosu: coin, Binance fiyati, DEX fiyati, fark, %, likidite
- Fark >%0.15 ve likidite >$500K → yesil arka plan + ARB! sinyali
- 3 saniyede bir otomatik guncelleme
- Sifir bagimlilik, sadece Node.js
- API anahtari gerektirmez

## Kurulum ve Calistirma

```bash
git clone https://github.com/memotur-droid/Marduk-Board.git
cd Marduk-Board
node monitor.js
```

## Gereksinimler

- Node.js 18+
- Internet baglantisi

## Kullanim

```
node monitor.js
```

Ctrl+C ile cikis yapilir. Terminal penceresi buyudukce daha fazla coin gosterilir.
README

echo ">>> Git'e ekleniyor..."
git add -A
git commit -m "Marduk Board: Binance vs DEX gercek zamanli fiyat farki monitoru"
git push origin main

echo ""
echo ">>> Tamamlandi! Calistirmak icin:"
echo "    node monitor.js"
