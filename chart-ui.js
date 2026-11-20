import {
  loadMarketBundle,
  connectSpotStream,
  getEconomicEvents,
  formatWibDate,
  formatWibTime,
  getMorningAnchor,
  getAntamOverride,
  saveAntamOverride,
  clearAntamOverride,
  getIntervalLabel,
} from "./data-service.js";
import {
  analyzeMarket,
  calculateIndicators,
  bollinger,
  backtestAccuracy,
  simulateForecast,
  buildDecision,
  scenarioBiasFromName,
  scoreCalendar,
} from "./quant-engine.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const els = {
  status: $("#feed-status"), clock: $("#wib-clock"), currentPrice: $("#current-price"), priceUnit: $("#price-unit"),
  priceChange: $("#price-change"), instrumentCaption: $("#instrument-caption"), instrumentSubline: $("#instrument-subline"),
  lastUpdated: $("#last-updated"), high24: $("#high-24h"), low24: $("#low-24h"), atrStat: $("#atr-stat"), volStat: $("#vol-stat"),
  tomorrowEstimate: $("#tomorrow-estimate"), tomorrowChange: $("#tomorrow-change"), premiumValue: $("#premium-value"),
  premiumStatus: $("#premium-status"), spotIdrLabel: $("#spot-idr-label"), breakevenDays: $("#breakeven-days"),
  breakevenSpread: $("#breakeven-spread"), antamSell: $("#antam-sell"), antamBuyback: $("#antam-buyback"), antamSource: $("#antam-source-label"),
  priceChart: $("#price-chart"), indicatorChart: $("#indicator-chart"), overlay: $("#news-overlay"), chartTooltip: $("#chart-tooltip"),
  chartPeriod: $("#chart-period-label"), chartFeed: $("#chart-feed-label"), chartLibraryNote: $("#chart-library-note"),
  indicatorName: $("#indicator-name"), indicatorValue: $("#indicator-value"), indicatorChips: $("#indicator-chips"),
  eventList: $("#event-list"), fan: $("#fan-chart"), fanEnd: $("#fan-end-label"), forecastTarget: $("#forecast-target"),
  forecastP10: $("#forecast-p10"), forecastP90: $("#forecast-p90"), forecastDirection: $("#forecast-direction"),
  forecastAccuracy: $("#forecast-accuracy"), forecastModel: $("#forecast-model-label"), gaugeScore: $("#gauge-score"),
  gaugeProgress: $("#gauge-progress"), gaugeNeedle: $("#gauge-needle"), decisionStatus: $("#decision-status"),
  decisionPill: $("#decision-pill"), decisionMode: $("#decision-mode"), decisionCopy: $("#decision-copy"),
  allocation: $("#allocation-value"), allocationBar: $("#allocation-bar"), allocationGuide: $("#allocation-guidance"),
  safeZone: $("#safe-zone-price"), safeDistance: $("#safe-zone-distance"), safeSource: $("#safe-zone-source"),
  scoreBars: { tech: $("#score-tech-bar"), vol: $("#score-vol-bar"), macro: $("#score-macro-bar"), calendar: $("#score-calendar-bar") },
  scoreValues: { tech: $("#score-tech"), vol: $("#score-vol"), macro: $("#score-macro"), calendar: $("#score-calendar") },
  fxSlider: $("#fx-slider"), fxSliderValue: $("#fx-slider-value"), simScore: $("#sim-score"), simDrawdown: $("#sim-drawdown"),
  simFootnote: $("#sim-footnote"), tickerSource: $("#ticker-source"), footerSource: $("#footer-source"),
  dialog: $("#price-dialog"), sellInput: $("#sell-input"), buybackInput: $("#buyback-input"), toast: $("#toast"),
};

const fmt = {
  usd: (value, digits = 2) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value),
  idr: (value, digits = 0) => `Rp ${new Intl.NumberFormat("id-ID", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Math.round(value))}`,
  compactIdr: (value) => `Rp ${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 }).format(Math.round(value))}`,
  number: (value, digits = 2) => new Intl.NumberFormat("id-ID", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value),
  percent: (value, digits = 2) => `${value > 0 ? "+" : ""}${new Intl.NumberFormat("id-ID", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)}%`,
};

const intervalSeconds = { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 };
const instrumentMeta = {
  spot: { caption: "HARGA SPOT · PER TROY OUNCE", unit: "USD/oz", name: "XAU/USD · harga spot emas global" },
  antam: { caption: "EMAS ANTAM LM 24K · PER GRAM", unit: "IDR/gr", name: "Harga resmi Antam LM otomatis (6x/hari)" },
  local: { caption: "EMAS 24K LOKAL · PER GRAM", unit: "IDR/gr", name: "Acuan pasar fisik 24K (UBS / Galeri24 / Toko)" },
};

const state = {
  bundle: null,
  timeframe: "1h",
  chartType: "candles",
  instrument: "spot",
  horizon: "24h",
  momentum: "rsi",
  indicators: { ema9: false, ema21: true, ema50: false, ema200: false, bollinger: false },
  events: getEconomicEvents(),
  override: getAntamOverride(),
  scenario: "neutral",
  scenarioFx: null,
  stats: null,
  transformedCandles: [],
  forecast: null,
  decision: null,
  chart: null,
  indicatorChart: null,
  mainSeries: null,
  bufferSeries: null,
  indicatorSeries: [],
  overlaySeries: [],
  streamLive: false,
  loading: false,
  toastTimer: null,
};

const formatMoney = (value, instrument = state.instrument) => instrument === "spot" ? fmt.usd(value, 2) : fmt.idr(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function localPricing(bundle = state.bundle) {
  if (!bundle) {
    return { spotPerGram: 0, antamSell: 0, antamBuyback: 0, localSell: 0, premium: 0, changeIdr: 0, changePct: 0, source: "ESTIMASI" };
  }
  const spotPerGram = (bundle.spot.price * bundle.fx.rate) / 31.1035;
  const antamSell = state.override?.sell || bundle.antam?.sell || Math.round(spotPerGram * 1.18 / 1000) * 1000;
  const antamBuyback = state.override?.buyback || bundle.antam?.buyback || Math.round(antamSell * 0.94 / 1000) * 1000;
  const localSell = Math.round(antamSell * 0.985 / 1000) * 1000;
  const changeIdr = bundle.antam?.changeIdr ?? 0;
  const changePct = bundle.antam?.changePct ?? bundle.spot.changePct;
  const source = state.override ? "INPUT MANUAL" : (bundle.antam?.source || "ESTIMASI");

  return { spotPerGram, antamSell, antamBuyback, localSell, premium: antamSell - spotPerGram, changeIdr, changePct, source };
}

function currentPrice(bundle = state.bundle) {
  if (!bundle) return 0;
  if (state.instrument === "spot") return bundle.spot.price;
  const prices = localPricing(bundle);
  return state.instrument === "antam" ? prices.antamSell : prices.localSell;
}

function scenarioPrice() {
  if (!state.bundle || state.instrument === "spot" || state.scenarioFx == null) return currentPrice();
  const basePrice = currentPrice();
  const fxRatio = state.scenarioFx / state.bundle.fx.rate;
  return basePrice * fxRatio;
}

function transformCandles(candles, bundle) {
  if (!candles.length) return [];
  if (state.instrument === "spot") return candles;
  const targetClose = currentPrice(bundle);
  const lastSpot = candles.at(-1).close || bundle.spot.price;
  const ratio = targetClose / lastSpot;
  return candles.map((candle) => ({
    ...candle,
    open: candle.open * ratio,
    high: candle.high * ratio,
    low: candle.low * ratio,
    close: candle.close * ratio,
  }));
}

function valueForInstrument(spotPrice, bundle) {
  if (state.instrument === "spot") return spotPrice;
  const targetClose = currentPrice(bundle);
  const ratio = targetClose / (bundle.spot.price || spotPrice);
  return spotPrice * ratio;
}

function setFeedStatus(live, streaming = state.streamLive) {
  const good = live || streaming;
  els.status.classList.toggle("simulated", !good);
  els.status.querySelector("span").textContent = good ? "AUTO SYNC 6X" : "KALIBRASI LOKAL";
  els.status.title = good ? "Sinkronisasi otomatis GitHub Actions & feed pasar aktif." : "Menggunakan kalibrasi lokal.";
  els.tickerSource.textContent = good ? "sinkronisasi aktif" : "kalibrasi lokal";
  els.chartFeed.textContent = state.bundle?.spot?.source || "XAU/USD Spot";
  els.footerSource.textContent = good ? "GitHub Actions (6x/hari) · Yahoo Finance · FairEconomy" : "Mode kalibrasi lokal · client-side";
}

function renderHeader() {
  const bundle = state.bundle;
  if (!bundle) return;
  const meta = instrumentMeta[state.instrument];
  const liveValue = currentPrice(bundle);
  const prices = localPricing(bundle);

  els.instrumentCaption.textContent = meta.caption;
  els.priceUnit.textContent = meta.unit;
  els.instrumentSubline.textContent =
    state.instrument === "antam" && state.override
      ? `Harga input manual · ${meta.name}`
      : meta.name;

  els.currentPrice.textContent = formatMoney(liveValue);

  const change = state.instrument === "spot" ? bundle.spot.changePct : prices.changePct;
  const idrDeltaText = state.instrument !== "spot" && prices.changeIdr !== 0
    ? ` (${prices.changeIdr > 0 ? "+" : ""}${fmt.compactIdr(prices.changeIdr)})`
    : "";
  els.priceChange.textContent = `${fmt.percent(change)}${idrDeltaText} hari ini`;
  els.priceChange.classList.toggle("positive", change >= 0);
  els.priceChange.classList.toggle("negative", change < 0);

  els.high24.textContent = formatMoney(valueForInstrument(bundle.spot.high, bundle));
  els.low24.textContent = formatMoney(valueForInstrument(bundle.spot.low, bundle));

  const composite = bundle.spot.price * bundle.fx.rate;
  const anchor = getMorningAnchor(composite);
  const compositeMove = clamp(anchor.value > 0 ? composite / anchor.value - 1 : 0, -0.025, 0.025);
  const tomorrow = prices.antamSell * (1 + compositeMove);

  els.tomorrowEstimate.textContent = fmt.compactIdr(tomorrow);
  els.tomorrowChange.textContent = `${fmt.percent(compositeMove * 100)} dari acuan pagi`;
  els.tomorrowChange.classList.toggle("positive", compositeMove >= 0);
  els.tomorrowChange.classList.toggle("negative", compositeMove < 0);

  const premiumPct = prices.spotPerGram > 0 ? (prices.antamSell / prices.spotPerGram - 1) * 100 : 0;
  els.premiumValue.textContent = `${fmt.number(premiumPct, 2)}%`;
  const premiumState = premiumPct > 22 ? "Premi ritel tinggi" : premiumPct < 14 ? "Premi terdiskon" : "Premi fisik wajar";
  els.premiumStatus.textContent = premiumState;
  els.premiumStatus.className = premiumPct > 22 ? "warning" : premiumPct < 14 ? "positive" : "neutral";
  els.spotIdrLabel.textContent = `spot murni / gr ${fmt.compactIdr(prices.spotPerGram)}`;

  els.antamSell.textContent = fmt.compactIdr(prices.antamSell);
  els.antamBuyback.textContent = fmt.compactIdr(prices.antamBuyback);
  els.antamSource.textContent = prices.source;
  els.antamSource.title = `Sumber harga: ${prices.source}`;

  const effectiveDailyGrowth = Math.max(state.stats?.dailyDrift || 0, 0.00025);
  const spread = prices.antamSell > 0 ? (1 - prices.antamBuyback / prices.antamSell) * 100 : 0;
  const days = Math.log(prices.antamSell / prices.antamBuyback) / effectiveDailyGrowth;
  els.breakevenDays.textContent = Number.isFinite(days) && days < 1800
    ? (days < 60 ? `~${Math.ceil(days)} hari` : `~${fmt.number(days / 30, 1)} bln`)
    : "~8,5 bln";
  els.breakevenSpread.textContent = `Spread ${fmt.number(spread, 2)}%`;
  els.breakevenSpread.className = spread <= 6.5 ? "positive" : spread <= 8.5 ? "warning" : "neutral";

  const stats = state.stats;
  const realisticDailyAtr = liveValue * (stats?.garchVol || 0.0045);
  els.atrStat.textContent = formatMoney(realisticDailyAtr);
  els.volStat.textContent = stats ? `${fmt.number(stats.annualizedVol * 100, 1)}%` : "–";
  els.lastUpdated.textContent = `Diperbarui ${new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(bundle.refreshedAt)} WIB`;
  setFeedStatus(bundle.isLive, state.streamLive);
}

function renderTicker() {
  const bundle = state.bundle;
  if (!bundle) return;
  const quote = (key, value, unit, digits = 2) => {
    const element = $(`#ticker-${key}`);
    if (!element) return;
    element.textContent = unit === "IDR"
      ? `Rp ${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 }).format(value)}`
      : `${fmt.number(value, digits)}${unit === "%" ? "%" : ""}`;
  };
  const setChange = (key, pct) => {
    const el = $(`#ticker-${key}-change`);
    if (!el) return;
    el.className = `ticker-change ${pct > 0.015 ? "positive" : pct < -0.015 ? "negative" : "neutral"}`;
    el.textContent = `${fmt.percent(pct, 2)} 1D`;
  };
  quote("fx", bundle.fx.rate, "IDR", 0);
  quote("dxy", bundle.macro.dxy.price, "", 2);
  quote("wti", bundle.macro.wti.price, "", 2);
  quote("silver", bundle.macro.silver.price, "", 2);
  quote("yield", bundle.macro.yield.price, "%", 2);
  setChange("fx", bundle.fx.changePct || 0);
  setChange("dxy", bundle.macro.dxy.changePct || 0);
  setChange("wti", bundle.macro.wti.changePct || 0);
  setChange("silver", bundle.macro.silver.changePct || 0);
  setChange("yield", bundle.macro.yield.changePct || 0);
}

function updateClock() {
  els.clock.textContent = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date());
}

function forecastFor(horizon = state.horizon, scenario = state.scenario) {
  if (!state.bundle || !state.stats) return null;
  const baseStats = state.stats;
  const fxDelta = state.scenarioFx == null || state.instrument === "spot"
    ? 0
    : (state.scenarioFx / state.bundle.fx.rate - 1) * 0.5;
  const scenarioBias = scenarioBiasFromName(scenario) + clamp(fxDelta, -0.002, 0.002);

  const indicator = baseStats.latest;
  const momentum = indicator?.ema21 ? clamp(Math.log(indicator.close / indicator.ema21), -0.015, 0.015) : 0;
  const macro = state.bundle.macro;
  const macroDrift = clamp(
    (-(macro.dxy?.changePct || 0) + (macro.wti?.changePct || 0) * 0.3 + (macro.silver?.changePct || 0) * 0.4 - (macro.yield?.changePct || 0) * 0.6) * 0.00012,
    -0.0005,
    0.0005
  );

  let modeledDrift = baseStats.dailyDrift;
  if (horizon === "24h") modeledDrift = baseStats.dailyDrift * 0.6 + ((indicator?.rsi || 50) - 50) / 120_000;
  else if (horizon === "72h") modeledDrift = baseStats.dailyDrift * 0.7 + momentum * 0.025;
  else if (horizon === "7d") modeledDrift = baseStats.dailyDrift * 0.55 + momentum * 0.015 + macroDrift;
  else if (horizon === "3m") modeledDrift = baseStats.dailyDrift * 0.35 + macroDrift * 0.8;
  else if (horizon === "6m") modeledDrift = 0.00022 + macroDrift * 0.6;
  else if (horizon === "12m") modeledDrift = 0.00024 + macroDrift * 0.5;

  const calendarInfo = scoreCalendar(state.events);
  return simulateForecast({
    currentPrice: scenarioPrice(),
    stats: { ...baseStats, dailyDrift: clamp(modeledDrift + scenarioBias, -0.0012, 0.0015) },
    horizon,
    scenarioBias: 0,
    simulations: 1000,
    highRiskEvent: calendarInfo.highRisk,
  });
}

function linePoints(curve, field, minValue, maxValue) {
  const left = 30;
  const right = 620;
  const top = 15;
  const bottom = 180;
  const maxStep = Math.max(1, curve.at(-1)?.step || 1);
  return curve.map((point) => {
    const x = left + (point.step / maxStep) * (right - left);
    const y = bottom - ((point[field] - minValue) / Math.max(1e-9, maxValue - minValue)) * (bottom - top);
    return [x, y];
  });
}

function renderFanChart(forecast) {
  if (!forecast) return;
  const all = forecast.curve.flatMap((point) => [point.p10, point.p50, point.p90]);
  let min = Math.min(...all);
  let max = Math.max(...all);
  const pad = Math.max((max - min) * 0.12, max * 0.0015);
  min -= pad;
  max += pad;
  const p10 = linePoints(forecast.curve, "p10", min, max);
  const p50 = linePoints(forecast.curve, "p50", min, max);
  const p90 = linePoints(forecast.curve, "p90", min, max);
  const points = (list) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const band = [...p10, ...[...p90].reverse()];
  const maxStep = Math.max(1, forecast.steps);
  const horizontal = [35, 80, 125, 170].map((y) => `<line class="fan-grid" x1="30" y1="${y}" x2="620" y2="${y}" />`).join("");
  els.fan.innerHTML = `${horizontal}<polygon class="fan-band" points="${points(band)}" /><line class="fan-now" x1="30" y1="12" x2="30" y2="181" /><polyline class="fan-line p90" points="${points(p90)}" /><polyline class="fan-line p10" points="${points(p10)}" /><polyline class="fan-line p50" points="${points(p50)}" /><circle class="fan-dot" cx="${p50.at(-1)[0]}" cy="${p50.at(-1)[1]}" r="3.5" /><text x="30" y="202" fill="#586373" font-size="8">0</text><text x="610" y="202" text-anchor="end" fill="#586373" font-size="8">${maxStep} hari</text>`;
  els.fan.setAttribute("aria-label", `Proyeksi ${forecast.horizonLabel}: persentil 10 sampai 90`);
  els.fanEnd.textContent = forecast.horizonLabel;
}

function renderForecastAndDecision() {
  if (!state.bundle || !state.stats) return;
  const forecast = forecastFor();
  state.forecast = forecast;
  state.decision = buildDecision({
    stats: state.stats,
    forecast,
    macro: state.bundle.macro,
    events: state.events,
    currentPrice: scenarioPrice(),
    fxChangePct: state.instrument === "spot" || state.scenarioFx == null ? 0 : (state.scenarioFx / state.bundle.fx.rate - 1) * 100,
    scenarioBias: scenarioBiasFromName(state.scenario),
  });
  renderFanChart(forecast);
  els.forecastTarget.textContent = formatMoney(forecast.p50);
  els.forecastP10.textContent = formatMoney(forecast.p10);
  els.forecastP90.textContent = formatMoney(forecast.p90);
  const direction = forecast.upProbability >= 0.54 ? "Bullish" : forecast.upProbability <= 0.46 ? "Bearish" : "Netral";
  els.forecastDirection.textContent = `${direction} · ${fmt.number(forecast.upProbability * 100, 0)}%`;
  const accuracy = backtestAccuracy(state.transformedCandles, state.horizon);
  els.forecastAccuracy.textContent = `${fmt.number(accuracy.mape, 2)}% · ${formatMoney(accuracy.rmse)}`;
  els.forecastModel.textContent = forecast.model.split(" + ")[0];
  renderDecision(state.decision);
  renderSimulator(state.decision);
}

function renderDecision(decision) {
  if (!decision) return;
  const score = decision.score;
  els.gaugeScore.textContent = `${score}%`;
  els.gaugeProgress.style.strokeDasharray = `${score} 100`;
  const angle = -90 + score * 1.8;
  els.gaugeNeedle.style.transform = `rotate(${angle}deg)`;
  els.gaugeProgress.style.stroke = score >= 68 ? "#10b981" : score < 45 ? "#ef4444" : "#d4af37";
  els.decisionPill.className = `decision-pill ${decision.variant === "extreme" ? "extreme" : decision.variant === "aggressive" ? "" : "defensive"}`;
  els.decisionMode.textContent = decision.mode;
  els.decisionCopy.textContent = decision.explanation;
  els.allocation.textContent = decision.allocation;
  els.allocationBar.style.width = `${decision.allocationPercent}%`;
  els.allocationBar.style.background = decision.variant === "extreme" ? "#ef4444" : decision.variant === "aggressive" ? "#10b981" : "#f59e0b";
  els.allocationGuide.textContent = decision.guidance;
  els.safeZone.textContent = formatMoney(decision.safeBuy);
  els.safeDistance.textContent = `${fmt.number(Math.abs(decision.safeBuyDistancePct), 2)}% di bawah harga saat ini`;
  els.safeSource.textContent = decision.highRisk ? "GARCH + Event Buffer" : "Simulasi Monte Carlo P10";

  const scores = { tech: decision.technical, vol: decision.volatility, macro: decision.macro, calendar: decision.calendar };
  for (const [key, value] of Object.entries(scores)) {
    els.scoreBars[key].style.width = `${value}%`;
    els.scoreValues[key].textContent = `${Math.round(value)}`;
  }
  const riskLabel = decision.highRisk ? "RISIKO BERITA" : "SKOR LIVE";
  els.decisionStatus.textContent = riskLabel;
  els.decisionStatus.classList.toggle("live", !decision.highRisk);
}

function renderSimulator(decision) {
  if (!state.bundle || !decision) return;
  const fx = state.scenarioFx ?? state.bundle.fx.rate;
  els.fxSliderValue.textContent = `Rp ${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 }).format(fx)}`;
  els.simScore.textContent = `${decision.score}%`;
  const scenarioCurrent = scenarioPrice();
  const down = Math.max(0, ((scenarioCurrent - (state.forecast?.p10 || scenarioCurrent)) / scenarioCurrent) * 100);
  els.simDrawdown.textContent = `−${fmt.number(down, 2)}%`;
  const scenarioLabel = { positive: "berita positif", neutral: "berita netral", bad: "berita buruk" }[state.scenario];
  const fxEffect = fx - state.bundle.fx.rate;
  els.simFootnote.textContent = `${scenarioLabel}; kurs ${fxEffect >= 0 ? "naik" : "turun"} ${fmt.compactIdr(Math.abs(fxEffect))} dari kurs berjalan. Drawdown memakai batas P10 pada horizon terpilih.`;
  const min = Number(els.fxSlider.min);
  const max = Number(els.fxSlider.max);
  const position = clamp(((fx - min) / (max - min)) * 100, 0, 100);
  els.fxSlider.style.background = `linear-gradient(90deg, var(--gold) 0%, var(--gold) ${position}%, #323846 ${position}%, #323846 100%)`;
}

function renderEvents() {
  const calendarTag = $(".calendar-demo-tag");
  if (calendarTag && state.bundle?.events?.length) {
    calendarTag.innerHTML = `<i></i>Kalender Ekonomi Live`;
  }
  const now = Math.floor(Date.now() / 1000);
  const emoji = { high: "⚡", medium: "▤", low: "◉" };
  els.eventList.innerHTML = state.events.map((event) => {
    const countdown = Math.max(0, Math.floor((event.time - now) / 3600));
    const dayLabel = formatWibDate(event.time);
    const timeLabel = formatWibTime(event.time);
    const impact = event.impact === "high" ? "Besar" : event.impact === "medium" ? "Sedang" : "Kecil";
    return `<div class="event-row"><div class="event-time">${dayLabel}<b>${timeLabel}</b></div><div class="event-main"><span class="event-emoji ${event.impact}">${emoji[event.impact]}</span><div class="event-copy"><div class="event-name" title="${event.name}">${event.name}</div><span class="event-move">${event.move} · ~${countdown} jam</span></div></div><span class="event-impact ${event.impact}">${impact}</span></div>`;
  }).join("");
}

function currentChartCandles() {
  if (!state.bundle) return [];
  const candles = transformCandles(state.bundle.candles, state.bundle);
  const latest = candles.at(-1);
  if (latest) {
    const value = currentPrice();
    latest.close = value;
    latest.high = Math.max(latest.high, value);
    latest.low = Math.min(latest.low, value);
  }
  return candles;
}

function chartOptions(container, height, rightScale = true) {
  const transparent = "rgba(19, 23, 34, 0)";
  return {
    width: Math.max(1, container.clientWidth),
    height,
    layout: { background: { color: transparent }, textColor: "#737d8d", fontFamily: "DM Mono, Consolas, monospace", fontSize: 9, attributionLogo: false },
    grid: { vertLines: { color: "#202632" }, horzLines: { color: "#202632" } },
    crosshair: { mode: window.LightweightCharts?.CrosshairMode?.Normal ?? 0, vertLine: { color: "#4b5565", labelBackgroundColor: "#2a303c" }, horzLine: { color: "#4b5565", labelBackgroundColor: "#2a303c" } },
    rightPriceScale: { visible: rightScale, borderColor: "#252b38", scaleMargins: { top: 0.13, bottom: 0.1 } },
    leftPriceScale: { visible: false },
    timeScale: { borderColor: "#252b38", timeVisible: true, secondsVisible: false, rightOffset: 13, fixLeftEdge: false, lockVisibleTimeRangeOnResize: true },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
  };
}

function getFutureWhitespace(candles) {
  if (!candles.length) return [];
  const lastTime = candles.at(-1).time;
  const step = intervalSeconds[state.timeframe] || 3600;
  const latestEvent = Math.max(lastTime + step * 18, ...state.events.map((event) => event.time + step * 3));
  const limit = lastTime + 7 * 86400;
  const end = Math.min(latestEvent, limit);
  const times = new Set();
  for (let time = lastTime + step; time <= end; time += step) times.add(time);
  for (const event of state.events) if (event.time > lastTime && event.time <= end) times.add(event.time);
  return [...times].sort((a, b) => a - b).map((time) => ({ time }));
}

function clearCharts() {
  if (state.chart && window.LightweightCharts) state.chart.remove();
  if (state.indicatorChart && window.LightweightCharts) state.indicatorChart.remove();
  state.chart = null;
  state.indicatorChart = null;
  state.mainSeries = null;
  state.bufferSeries = null;
  state.indicatorSeries = [];
  state.overlaySeries = [];
}

function addMainSeries(chart) {
  const lib = window.LightweightCharts;
  if (!lib) return null;
  if (state.chartType === "line") {
    return chart.addLineSeries({ color: "#d4af37", lineWidth: 2, priceLineVisible: true, lastValueVisible: true, crosshairMarkerRadius: 3 });
  }
  return chart.addCandlestickSeries({
    upColor: "#10b981", downColor: "#ef4444", borderUpColor: "#10b981", borderDownColor: "#ef4444",
    wickUpColor: "#10b981", wickDownColor: "#ef4444", priceLineVisible: true, lastValueVisible: true,
  });
}

function filteredLineData(times, values) {
  return times.flatMap((time, index) => values[index] == null || !Number.isFinite(values[index]) ? [] : [{ time, value: values[index] }]);
}

function addOverlayLines(chart, candles) {
  const lib = window.LightweightCharts;
  if (!lib) return;
  const indicators = calculateIndicators(candles);
  const times = candles.map((bar) => bar.time);
  const lines = [
    ["ema9", indicators.ema9, "#e879f9"],
    ["ema21", indicators.ema21, "#f5bd54"],
    ["ema50", indicators.ema50, "#60a5fa"],
    ["ema200", indicators.ema200, "#34d399"],
  ];
  for (const [key, values, color] of lines) {
    if (!state.indicators[key]) continue;
    const series = chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    series.setData(filteredLineData(times, values));
    state.overlaySeries.push(series);
  }
  if (state.indicators.bollinger) {
    const bands = bollinger(candles.map((bar) => bar.close));
    for (const [values, color] of [[bands.upper, "#9b8be8"], [bands.lower, "#9b8be8"]]) {
      const series = chart.addLineSeries({ color, lineWidth: 1, lineStyle: lib.LineStyle?.Dashed ?? 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      series.setData(filteredLineData(times, values));
      state.overlaySeries.push(series);
    }
  }
}

function positionNewsMarkers() {
  if (!state.chart || !state.mainSeries) {
    renderFallbackMarkers();
    return;
  }
  const timeScale = state.chart.timeScale();
  const width = els.overlay.clientWidth;
  els.overlay.replaceChildren();
  state.events.forEach((event, index) => {
    const x = timeScale.timeToCoordinate(event.time);
    if (x == null || x < 26 || x > width - 28) return;
    const marker = document.createElement("button");
    const hours = (event.time - Date.now() / 1000) / 3600;
    marker.type = "button";
    marker.className = `news-marker ${event.impact} ${event.impact === "high" && hours < 3 ? "pulsing" : ""}`;
    marker.style.left = `${x}px`;
    marker.style.top = `${4 + (index % 2) * 25}px`;
    marker.textContent = `${event.impact === "high" ? "⚡" : event.impact === "medium" ? "▤" : "◉"} ${formatWibTime(event.time)}`;
    marker.title = `${event.name} · ${formatWibDate(event.time)} ${formatWibTime(event.time)} WIB`;
    marker.addEventListener("mouseenter", () => {
      els.chartTooltip.hidden = false;
      els.chartTooltip.textContent = `${event.name} · ${formatWibDate(event.time)} pukul ${formatWibTime(event.time)} WIB · ${event.move}`;
    });
    marker.addEventListener("mouseleave", () => { els.chartTooltip.hidden = true; });
    els.overlay.append(marker);
  });
}

function renderFallbackMarkers() {
  const candles = state.transformedCandles;
  if (!candles.length) return;
  const width = els.overlay.clientWidth;
  const chartWidth = els.priceChart.clientWidth;
  const lastTime = candles.at(-1).time;
  const endTime = Math.max(lastTime + 7 * 86400, ...state.events.map((event) => event.time));
  els.overlay.replaceChildren();
  state.events.forEach((event, index) => {
    if (event.time < lastTime || event.time > endTime) return;
    const ratio = (event.time - lastTime) / (endTime - lastTime);
    const x = Math.max(34, chartWidth - 64 + ratio * 36);
    if (x > width - 18) return;
    const marker = document.createElement("span");
    marker.className = `news-marker ${event.impact}`;
    marker.style.left = `${x}px`;
    marker.style.top = `${4 + (index % 2) * 24}px`;
    marker.textContent = `${event.impact === "high" ? "⚡" : "◉"} ${formatWibTime(event.time)}`;
    marker.title = `${event.name}`;
    els.overlay.append(marker);
  });
}

function drawCanvasFallback(candles) {
  els.priceChart.innerHTML = "";
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", "Grafik harga emas");
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  els.priceChart.append(canvas);
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = rect.width * ratio;
  canvas.height = rect.height * ratio;
  ctx.scale(ratio, ratio);
  const width = rect.width;
  const height = rect.height;
  const left = 4;
  const right = width - 60;
  const top = 12;
  const bottom = height - 22;
  const values = candles.flatMap((bar) => [bar.high, bar.low]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const y = (value) => bottom - ((value - min) / Math.max(max - min, 1e-9)) * (bottom - top);
  ctx.strokeStyle = "#202632";
  ctx.lineWidth = 1;
  for (let line = 0; line < 5; line += 1) {
    const yy = top + (bottom - top) * line / 4;
    ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(width, yy); ctx.stroke();
  }
  const step = (right - left) / candles.length;
  const bodyWidth = Math.max(1, step * 0.63);
  if (state.chartType === "line") {
    ctx.beginPath();
    candles.forEach((bar, index) => {
      const x = left + index * step + step / 2;
      if (index === 0) ctx.moveTo(x, y(bar.close)); else ctx.lineTo(x, y(bar.close));
    });
    ctx.strokeStyle = "#d4af37"; ctx.lineWidth = 1.8; ctx.stroke();
  } else {
    candles.forEach((bar, index) => {
      const x = left + index * step + step / 2;
      const up = bar.close >= bar.open;
      ctx.strokeStyle = up ? "#10b981" : "#ef4444";
      ctx.fillStyle = up ? "#10b981" : "#ef4444";
      ctx.beginPath(); ctx.moveTo(x, y(bar.high)); ctx.lineTo(x, y(bar.low)); ctx.stroke();
      const topBody = y(Math.max(bar.open, bar.close));
      const bodyHeight = Math.max(1, Math.abs(y(bar.open) - y(bar.close)));
      ctx.fillRect(x - bodyWidth / 2, topBody, bodyWidth, bodyHeight);
    });
  }
  els.chartLibraryNote.textContent = "Fallback grafik lokal";
  renderFallbackMarkers();
}

function drawFallbackIndicator(candles) {
  els.indicatorChart.innerHTML = "";
  const canvas = document.createElement("canvas");
  canvas.style.width = "100%"; canvas.style.height = "100%";
  els.indicatorChart.append(canvas);
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = rect.width * ratio; canvas.height = rect.height * ratio; ctx.scale(ratio, ratio);
  const indicator = calculateIndicators(candles);
  const values = state.momentum === "rsi" ? indicator.rsi : indicator.macd.histogram;
  const finiteValues = values.filter(Number.isFinite);
  const min = state.momentum === "rsi" ? 0 : Math.min(...finiteValues);
  const max = state.momentum === "rsi" ? 100 : Math.max(...finiteValues);
  const pad = (max - min) * 0.06 || 1;
  const y = (value) => rect.height - 5 - ((value - (min - pad)) / (max - min + 2 * pad)) * (rect.height - 10);
  ctx.strokeStyle = "#252b38";
  ctx.beginPath(); ctx.moveTo(0, rect.height / 2); ctx.lineTo(rect.width, rect.height / 2); ctx.stroke();
  ctx.beginPath();
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    const x = index / Math.max(1, values.length - 1) * rect.width;
    if (!Number.isFinite(values[index - 1])) ctx.moveTo(x, y(value)); else ctx.lineTo(x, y(value));
  });
  ctx.strokeStyle = state.momentum === "rsi" ? "#a78bfa" : "#60a5fa"; ctx.lineWidth = 1.5; ctx.stroke();
}

function renderCharts() {
  const candles = currentChartCandles();
  state.transformedCandles = candles;
  if (!candles.length || !els.priceChart.clientWidth) return;
  const lib = window.LightweightCharts;
  if (!lib?.createChart) {
    drawCanvasFallback(candles);
    drawFallbackIndicator(candles);
    positionNewsMarkers();
    return;
  }
  clearCharts();
  const mainHeight = Math.max(260, els.priceChart.clientHeight);
  state.chart = lib.createChart(els.priceChart, chartOptions(els.priceChart, mainHeight));
  state.mainSeries = addMainSeries(state.chart);
  const historicalData = state.chartType === "line"
    ? candles.map((bar) => ({ time: bar.time, value: bar.close }))
    : candles;
  state.mainSeries.setData(historicalData);
  state.bufferSeries = state.chart.addLineSeries({ visible: false, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  state.bufferSeries.setData(getFutureWhitespace(candles));
  addOverlayLines(state.chart, candles);
  state.chart.timeScale().fitContent();
  state.chart.timeScale().applyOptions({ rightOffset: 14 });
  state.chart.subscribeCrosshairMove((param) => {
    if (!param?.time || !param.seriesData?.get(state.mainSeries)) return;
    const value = param.seriesData.get(state.mainSeries);
    const close = value.close ?? value.value;
    if (Number.isFinite(close)) els.currentPrice.textContent = formatMoney(close);
  });

  state.indicatorChart = lib.createChart(els.indicatorChart, {
    ...chartOptions(els.indicatorChart, Math.max(55, els.indicatorChart.clientHeight), false),
    timeScale: { visible: false, borderVisible: false, rightOffset: 14 },
    rightPriceScale: { visible: false },
    grid: { vertLines: { visible: false, color: "transparent" }, horzLines: { color: "#202632" } },
    crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
  });
  const indicators = calculateIndicators(candles);
  if (state.momentum === "rsi") {
    const series = state.indicatorChart.addLineSeries({ color: "#a78bfa", lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    series.setData(filteredLineData(candles.map((bar) => bar.time), indicators.rsi));
    series.createPriceLine({ price: 70, color: "#584f70", lineWidth: 1, lineStyle: lib.LineStyle?.Dashed ?? 2, axisLabelVisible: false });
    series.createPriceLine({ price: 30, color: "#584f70", lineWidth: 1, lineStyle: lib.LineStyle?.Dashed ?? 2, axisLabelVisible: false });
    state.indicatorSeries.push(series);
    els.indicatorValue.textContent = fmt.number(indicators.latest.rsi, 1);
    els.indicatorName.textContent = "RSI (14)";
  } else {
    const series = state.indicatorChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false, base: 0 });
    series.setData(indicators.macd.histogram.map((value, index) => ({ time: candles[index].time, value, color: value >= 0 ? "rgba(16,185,129,.72)" : "rgba(239,68,68,.72)" })));
    state.indicatorSeries.push(series);
    els.indicatorValue.textContent = fmt.number(indicators.latest.macd - indicators.latest.macdSignal, 2);
    els.indicatorName.textContent = "MACD (12, 26, 9)";
  }
  state.indicatorChart.timeScale().fitContent();
  els.chartLibraryNote.textContent = "Charts powered by Lightweight Charts";
  requestAnimationFrame(positionNewsMarkers);
}

function renderAll() {
  if (!state.bundle) return;
  const sourceCandles = transformCandles(state.bundle.candles, state.bundle);
  if (sourceCandles.length) {
    const current = currentPrice();
    const latest = sourceCandles.at(-1);
    latest.close = current;
    latest.high = Math.max(latest.high, current);
    latest.low = Math.min(latest.low, current);
  }
  state.stats = analyzeMarket(sourceCandles, state.timeframe);
  renderHeader();
  renderTicker();
  renderEvents();
  renderCharts();
  renderForecastAndDecision();
}

async function refreshData({ preserveStream = true } = {}) {
  if (state.loading) return;
  state.loading = true;
  try {
    const bundle = await loadMarketBundle(state.timeframe, 200);
    state.bundle = bundle;
    state.events = bundle.events?.length ? bundle.events : getEconomicEvents();
    if (state.scenarioFx == null) {
      state.scenarioFx = clamp(Math.round(bundle.fx.rate / 50) * 50, Number(els.fxSlider.min), Number(els.fxSlider.max));
      els.fxSlider.value = String(state.scenarioFx);
    }
    renderAll();
    if (!preserveStream && state.streamCloser) {
      state.streamCloser();
      state.streamCloser = null;
    }
  } catch (error) {
    console.warn("PredictGoldDelano refresh failed", error);
    if (state.bundle) renderAll();
  } finally {
    state.loading = false;
  }
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => els.toast.classList.remove("visible"), 2800);
}

function rerenderForecast() {
  if (!state.bundle) return;
  renderForecastAndDecision();
}

function bindControls() {
  $$(".instrument-tab").forEach((button) => button.addEventListener("click", () => {
    state.instrument = button.dataset.instrument;
    $$(".instrument-tab").forEach((tab) => {
      const selected = tab === button;
      tab.classList.toggle("active", selected);
      tab.setAttribute("aria-selected", String(selected));
    });
    renderAll();
  }));

  $$(".timeframe").forEach((button) => button.addEventListener("click", async () => {
    if (state.timeframe === button.dataset.timeframe) return;
    state.timeframe = button.dataset.timeframe;
    $$(".timeframe").forEach((item) => item.classList.toggle("active", item === button));
    els.chartPeriod.textContent = `${getIntervalLabel(state.timeframe)} · 200 candle`;
    await refreshData();
  }));

  $$(".chart-type").forEach((button) => button.addEventListener("click", () => {
    state.chartType = button.dataset.chartType;
    $$(".chart-type").forEach((item) => item.classList.toggle("active", item === button));
    renderCharts();
  }));

  $("#indicator-toggle").addEventListener("click", () => {
    const expanded = $("#indicator-toggle").getAttribute("aria-expanded") === "true";
    $("#indicator-toggle").setAttribute("aria-expanded", String(!expanded));
    els.indicatorChips.hidden = expanded;
  });

  $$("[data-indicator]").forEach((input) => input.addEventListener("change", () => {
    state.indicators[input.dataset.indicator] = input.checked;
    renderCharts();
  }));

  $$(".momentum-tab").forEach((button) => button.addEventListener("click", () => {
    state.momentum = button.dataset.momentum;
    $$(".momentum-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
    renderCharts();
  }));

  $$(".horizon-tab").forEach((button) => button.addEventListener("click", () => {
    state.horizon = button.dataset.horizon;
    $$(".horizon-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
    rerenderForecast();
  }));

  $$("[data-scenario]").forEach((button) => button.addEventListener("click", () => {
    state.scenario = button.dataset.scenario;
    $$("[data-scenario]").forEach((item) => item.classList.toggle("selected", item === button));
    rerenderForecast();
  }));

  els.fxSlider.addEventListener("input", () => {
    state.scenarioFx = Number(els.fxSlider.value);
    rerenderForecast();
  });

  $("#open-simulator").addEventListener("click", () => {
    els.fxSlider.closest(".simulator-panel").scrollIntoView({ behavior: "smooth", block: "center" });
    els.fxSlider.focus({ preventScroll: true });
  });

  $("#open-price-modal").addEventListener("click", () => {
    state.override = getAntamOverride();
    els.sellInput.value = state.override?.sell || "";
    els.buybackInput.value = state.override?.buyback || "";
    els.dialog.showModal();
  });

  $("#price-form").addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      state.override = saveAntamOverride(els.sellInput.value, els.buybackInput.value);
      els.dialog.close();
      renderAll();
      showToast("Harga manual disimpan sebagai pengganti sementara.");
    } catch (error) {
      showToast(error.message || "Harga belum valid.");
    }
  });

  $("#clear-override").addEventListener("click", () => {
    clearAntamOverride();
    state.override = null;
    els.sellInput.value = "";
    els.buybackInput.value = "";
    els.dialog.close();
    renderAll();
    showToast("Kembali ke harga Antam otomatis.");
  });

  $("#refresh-button").addEventListener("click", () => refreshData());
  $("#source-details").addEventListener("click", () => showToast("Otomatis 6x/hari via GitHub Actions: Logam Mulia, Yahoo Finance (GC=F), & Kalender FairEconomy."));
  els.dialog.addEventListener("click", (event) => { if (event.target === els.dialog) els.dialog.close(); });
}

function syncCanvasFallbackOnResize() {
  if (!window.LightweightCharts && state.bundle) renderCharts();
  else if (state.chart) {
    state.chart.applyOptions({ width: els.priceChart.clientWidth, height: els.priceChart.clientHeight });
    state.indicatorChart?.applyOptions({ width: els.indicatorChart.clientWidth, height: els.indicatorChart.clientHeight });
    requestAnimationFrame(positionNewsMarkers);
  }
}

async function boot() {
  updateClock();
  setInterval(updateClock, 1000);
  setInterval(() => {
    if (state.bundle) {
      state.events = state.bundle.events?.length ? state.bundle.events : getEconomicEvents();
      renderEvents();
      positionNewsMarkers();
    }
  }, 60_000);
  bindControls();
  await refreshData();
  state.streamCloser = connectSpotStream(() => {});
  setInterval(() => refreshData(), 90_000);
  window.addEventListener("resize", syncCanvasFallbackOnResize, { passive: true });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();