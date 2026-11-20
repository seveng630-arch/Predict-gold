const GOLDPRICE_ORG_URL = "https://data-asg.goldprice.org/dbXRates/USD";
const FX_URL = "https://open.er-api.com/v6/latest/USD";
const ACTION_DATA_URL = "./data/market_data.json";

const STORAGE = {
  morning: "pgd:morning-anchor:v3",
  antam: "pgd:antam-override:v3",
};

const intervalConfig = {
  "15m": { ms: 15 * 60_000, label: "15 menit" },
  "1h": { ms: 60 * 60_000, label: "1 jam" },
  "4h": { ms: 4 * 60 * 60_000, label: "4 jam" },
  "1d": { ms: 24 * 60 * 60_000, label: "1 hari" },
  "1w": { ms: 7 * 24 * 60 * 60_000, label: "1 minggu" },
};

function safeStorageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeStorageSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

async function fetchJson(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function aggregateCandles(candles, groupSize) {
  const result = [];
  for (let i = 0; i < candles.length; i += groupSize) {
    const slice = candles.slice(i, i + groupSize);
    if (!slice.length) continue;
    result.push({
      time: slice[0].time,
      open: slice[0].open,
      high: Math.max(...slice.map((c) => c.high)),
      low: Math.min(...slice.map((c) => c.low)),
      close: slice.at(-1).close,
      volume: slice.reduce((sum, c) => sum + (c.volume || 0), 0),
    });
  }
  return result;
}

export function fallbackCandles(interval = "1h", limit = 200, targetClose = 3968) {
  const config = intervalConfig[interval] || intervalConfig["1h"];
  const now = Date.now();
  const lastBucket = Math.floor(now / config.ms) * config.ms;
  const candles = [];
  for (let index = 0; index < limit; index += 1) {
    const timeMs = lastBucket - (limit - 1 - index) * config.ms;
    candles.push({
      time: Math.floor(timeMs / 1000),
      open: targetClose,
      high: targetClose * 1.001,
      low: targetClose * 0.999,
      close: targetClose,
      volume: 100,
    });
  }
  return candles;
}

async function fetchActionSnapshot() {
  return await fetchJson(`${ACTION_DATA_URL}?t=${Date.now()}`, 5000);
}

async function fetchLiveSpotOverlay() {
  try {
    const data = await fetchJson(GOLDPRICE_ORG_URL, 4500);
    const item = data?.items?.[0];
    const price = Number(item?.xauPrice);
    if (Number.isFinite(price) && price > 1000) {
      return { price, changePct: Number(item?.pcXau) || 0 };
    }
  } catch { /* gunakan snapshot GitHub Actions */ }
  return null;
}

async function fetchLiveFxOverlay() {
  try {
    const data = await fetchJson(FX_URL, 4500);
    const rate = Number(data?.rates?.IDR);
    if (Number.isFinite(rate) && rate > 10000) return rate;
  } catch { /* gunakan snapshot GitHub Actions */ }
  return null;
}

export async function loadMarketBundle(interval = "1h", limit = 200) {
  const [actionResult, liveSpotResult, liveFxResult] = await Promise.allSettled([
    fetchActionSnapshot(),
    fetchLiveSpotOverlay(),
    fetchLiveFxOverlay(),
  ]);

  const action = actionResult.status === "fulfilled" ? actionResult.value : null;
  const liveSpot = liveSpotResult.status === "fulfilled" ? liveSpotResult.value : null;
  const liveFx = liveFxResult.status === "fulfilled" ? liveFxResult.value : null;

  const spotPrice = liveSpot?.price || action?.spot?.price || 3968.5;
  const fxRate = liveFx || action?.fx?.rate || 16350;

  let candles = [];
  if (action?.candles1h?.length) {
    if (interval === "1d") candles = action.candles1d || aggregateCandles(action.candles1h, 24);
    else if (interval === "1w") candles = aggregateCandles(action.candles1d || action.candles1h, 5);
    else if (interval === "4h") candles = aggregateCandles(action.candles1h, 4);
    else candles = [...action.candles1h];
  } else {
    candles = fallbackCandles(interval, limit, spotPrice);
  }

  if (candles.length && liveSpot?.price) {
    const last = { ...candles.at(-1) };
    last.close = liveSpot.price;
    last.high = Math.max(last.high, liveSpot.price);
    last.low = Math.min(last.low, liveSpot.price);
    candles[candles.length - 1] = last;
  }

  const spot = {
    price: spotPrice,
    changePct: liveSpot?.changePct ?? action?.spot?.changePct ?? 0,
    high: action?.spot?.high || Math.max(...candles.slice(-24).map((b) => b.high)),
    low: action?.spot?.low || Math.min(...candles.slice(-24).map((b) => b.low)),
    source: action ? `GitHub Actions (${action.updatedAtWib})` : "Live Spot Feed",
  };

  const fx = {
    rate: fxRate,
    changePct: action?.fx?.changePct ?? 0,
    source: liveFx ? "ExchangeRate-API Live" : (action?.fx?.source || "Acuan BI"),
  };

  const macro = action?.macro || {
    dxy: { price: 104.15, changePct: 0, suffix: "pts" },
    wti: { price: 69.85, changePct: 0, suffix: "$/bbl" },
    silver: { price: 31.45, changePct: 0, suffix: "$/oz" },
    yield: { price: 4.28, changePct: 0, suffix: "%" },
  };

  return {
    candles: candles.slice(-limit),
    spot,
    fx,
    antam: action?.antam || null,
    antamHistory: action?.antamHistory || [],
    events: action?.events || [],
    macro,
    morningPrice: null,
    isLive: Boolean(action || liveSpot),
    refreshedAt: Date.now(),
    interval,
  };
}

export function connectSpotStream() {
  return () => {};
}

function jakartaParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function jakartaDateKey(date = new Date()) {
  const p = jakartaParts(date);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function getEconomicEvents(now = new Date()) {
  const nowSec = Math.floor(now.getTime() / 1000);
  const parts = jakartaParts(now);
  const events = [];

  for (let offset = 0; offset <= 7; offset += 1) {
    const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth();
    const day = d.getUTCDate();
    const dow = d.getUTCDay();

    if (dow === 5 && day <= 7) {
      events.push({ time: Math.floor(Date.UTC(year, month, day, 19 - 7, 30) / 1000), impact: "high", name: "[USD] Non-Farm Payrolls (NFP)", icon: "⚡", move: "XAU/USD ±1,5–3,2%" });
    }
    if (day === 13 && dow !== 0 && dow !== 6) {
      events.push({ time: Math.floor(Date.UTC(year, month, day, 19 - 7, 30) / 1000), impact: "high", name: "[USD] Inflasi US CPI", icon: "⚡", move: "XAU/USD ±1,4–3,0%" });
    }
    if (dow === 3 && day >= 15 && day <= 21) {
      events.push({ time: Math.floor(Date.UTC(year, month, day, 14 - 7, 30) / 1000), impact: "medium", name: "[IDR] Keputusan Suku Bunga BI-Rate", icon: "▤", move: "Antam ±Rp 8.000–20.000" });
    }
    if (dow === 4 && day >= 22 && day <= 28) {
      events.push({ time: Math.floor(Date.UTC(year, month, day, 20 - 7, 30) / 1000), impact: "high", name: "[USD] Core PCE Price Index", icon: "⚡", move: "XAU/USD ±1,2–2,5%" });
    }
    if (dow === 4) {
      events.push({ time: Math.floor(Date.UTC(year, month, day, 20 - 7, 30) / 1000), impact: "low", name: "[USD] Initial Jobless Claims", icon: "◉", move: "XAU/USD ±0,15–0,40%" });
    }
  }

  return events.filter((event) => event.time > nowSec).sort((a, b) => a.time - b.time).slice(0, 6);
}

export function formatWibTime(timestamp, options = { hour: "2-digit", minute: "2-digit" }) {
  return new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", ...options }).format(new Date(timestamp * 1000));
}

export function formatWibDate(timestamp, options = { weekday: "short", day: "2-digit", month: "short" }) {
  return new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", ...options }).format(new Date(timestamp * 1000));
}

export function getMorningAnchor(compositePrice) {
  const today = jakartaDateKey();
  try {
    const previous = JSON.parse(safeStorageGet(STORAGE.morning) || "null");
    if (previous?.date === today && Number(previous?.value) > 0) return previous;
    const current = { date: today, value: compositePrice, savedAt: Date.now(), source: "first-load" };
    safeStorageSet(STORAGE.morning, JSON.stringify(current));
    return current;
  } catch {
    return { date: today, value: compositePrice, savedAt: Date.now() };
  }
}

export function getAntamOverride() {
  try {
    const value = JSON.parse(safeStorageGet(STORAGE.antam) || "null");
    return value && Number(value.sell) > 0 && Number(value.buyback) > 0 ? value : null;
  } catch { return null; }
}

export function saveAntamOverride(sell, buyback) {
  const value = { sell: Number(sell), buyback: Number(buyback), updatedAt: Date.now(), date: jakartaDateKey() };
  if (!(value.sell > 0 && value.buyback > 0 && value.buyback <= value.sell)) {
    throw new Error("Masukkan harga jual dan buyback yang valid.");
  }
  safeStorageSet(STORAGE.antam, JSON.stringify(value));
  return value;
}

export function clearAntamOverride() {
  try { localStorage.removeItem(STORAGE.antam); return true; } catch { return false; }
}

export function getIntervalLabel(interval) {
  return intervalConfig[interval]?.label || intervalConfig["1h"].label;
}