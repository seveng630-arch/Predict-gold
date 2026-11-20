import json
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

WIB = timezone(timedelta(hours=7))
DATA_PATH = Path("data/market_data.json")
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
}


def fetch_url(url, timeout=15):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="ignore")


def fetch_yahoo_chart(symbol, range_str="1mo", interval="1h"):
    encoded = urllib.parse.quote(symbol)
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
        try:
            url = f"https://{host}/v8/finance/chart/{encoded}?range={range_str}&interval={interval}"
            raw = json.loads(fetch_url(url, timeout=12))
            result = raw["chart"]["result"][0]
            meta = result["meta"]
            timestamps = result.get("timestamp", [])
            quote = result["indicators"]["quote"][0]

            candles = []
            for i, ts in enumerate(timestamps):
                o = quote["open"][i]
                h = quote["high"][i]
                l = quote["low"][i]
                c = quote["close"][i]
                v = quote["volume"][i] or 0
                if None not in (o, h, l, c) and c > 0:
                    candles.append({
                        "time": int(ts),
                        "open": round(float(o), 2),
                        "high": round(float(h), 2),
                        "low": round(float(l), 2),
                        "close": round(float(c), 2),
                        "volume": round(float(v), 2),
                    })

            price = float(meta.get("regularMarketPrice") or (candles[-1]["close"] if candles else 0))
            prev = float(meta.get("chartPreviousClose") or meta.get("previousClose") or price)
            change_pct = ((price / prev) - 1) * 100 if prev else 0.0
            if price > 0:
                return {
                    "price": round(price, 2),
                    "prevClose": round(prev, 2),
                    "changePct": round(change_pct, 2),
                    "candles": candles,
                }
        except Exception:
            continue
    return None


def fetch_backup_spot():
    try:
        raw = json.loads(fetch_url("https://data-asg.goldprice.org/dbXRates/USD", timeout=10))
        item = raw["items"][0]
        return float(item["xauPrice"]), float(item.get("pcXau") or 0)
    except Exception:
        return None, None


def fetch_backup_fx():
    try:
        raw = json.loads(fetch_url("https://open.er-api.com/v6/latest/USD", timeout=10))
        return float(raw["rates"]["IDR"])
    except Exception:
        return None


def scrape_antam_prices():
    # Jalur 1: Logam Mulia Resmi
    try:
        html = fetch_url("https://www.logammulia.com/id/harga-emas-hari-ini")
        sell_matches = re.findall(r"1\s*gr.*?([\d]{1,3}(?:\.[\d]{3}){2})", html, re.S | re.I)
        buyback_match = re.search(r"Harga\s*Buyback.*?Rp\s*([\d]{1,3}(?:\.[\d]{3}){2})", html, re.S | re.I)
        if sell_matches:
            sell = int(sell_matches[0].replace(".", ""))
            buyback = int(buyback_match.group(1).replace(".", "")) if buyback_match else int(round(sell * 0.942, -3))
            if 1_200_000 <= sell <= 5_000_000:
                return sell, buyback, "Logam Mulia Resmi"
    except Exception:
        pass

    # Jalur 2: Galeri24 / Pegadaian
    try:
        html = fetch_url("https://galeri24.co.id/harga-emas")
        matches = re.findall(r"ANTAM.*?1\s*gr.*?Rp\s*([\d]{1,3}(?:\.[\d]{3}){2})", html, re.S | re.I)
        if matches:
            sell = int(matches[0].replace(".", ""))
            if 1_200_000 <= sell <= 5_000_000:
                return sell, int(round(sell * 0.94, -3)), "Galeri24 Antam"
    except Exception:
        pass

    # Jalur 3: Harga-Emas.org
    try:
        html = fetch_url("https://harga-emas.org/")
        matches = re.findall(r"Antam.*?1\s*gram.*?([\d]{1,3}(?:\.[\d]{3}){2})", html, re.S | re.I)
        if matches:
            sell = int(matches[0].replace(".", ""))
            if 1_200_000 <= sell <= 5_000_000:
                return sell, int(round(sell * 0.94, -3)), "Harga-Emas.org"
    except Exception:
        pass

    return None, None, None


def fetch_economic_news(now_wib):
    impact_map = {
        "High": ("high", "⚡", "Gejolak Besar (±1,2–3,5%)"),
        "Medium": ("medium", "▤", "Gejolak Sedang (±0,4–1,2%)"),
        "Low": ("low", "◉", "Fluktuasi Ringan (±0,05–0,35%)"),
    }
    now_ts = int(now_wib.timestamp())
    events = []

    for feed_name in ("ff_calendar_thisweek.json", "ff_calendar_nextweek.json"):
        try:
            url = f"https://nfs.faireconomy.media/{feed_name}"
            items = json.loads(fetch_url(url, timeout=12))
            for item in items:
                if item.get("country") not in ("USD", "IDR"):
                    continue
                raw_impact = item.get("impact", "")
                if raw_impact not in impact_map:
                    continue

                dt = datetime.fromisoformat(item["date"])
                ts = int(dt.timestamp())
                if ts <= now_ts:
                    continue

                level, icon, default_move = impact_map[raw_impact]
                forecast = (item.get("forecast") or "").strip()
                previous = (item.get("previous") or "").strip()
                detail = f"Fcst: {forecast} | Prev: {previous}" if forecast else default_move

                events.append({
                    "time": ts,
                    "impact": level,
                    "name": f"[{item['country']}] {item['title']}",
                    "icon": icon,
                    "move": detail,
                    "forecast": forecast,
                    "previous": previous,
                })
        except Exception:
            continue

    events.sort(key=lambda x: x["time"])
    return events[:10]


def main():
    now_wib = datetime.now(WIB)
    today_str = now_wib.strftime("%Y-%m-%d")

    previous_data = {}
    if DATA_PATH.exists():
        try:
            previous_data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
        except Exception:
            previous_data = {}

    gold_1h = fetch_yahoo_chart("GC=F", range_str="1mo", interval="1h")
    gold_1d = fetch_yahoo_chart("GC=F", range_str="1y", interval="1d")
    fx = fetch_yahoo_chart("IDR=X", range_str="5d", interval="1h")
    dxy = fetch_yahoo_chart("DX-Y.NYB", range_str="5d", interval="1d")
    wti = fetch_yahoo_chart("CL=F", range_str="5d", interval="1d")
    silver = fetch_yahoo_chart("SI=F", range_str="5d", interval="1d")
    us10y = fetch_yahoo_chart("^TNX", range_str="5d", interval="1d")

    # Fallback harga spot & kurs jika Yahoo membatasi IP server
    backup_spot, backup_spot_chg = fetch_backup_spot()
    spot_price = (gold_1h["price"] if gold_1h else None) or backup_spot or previous_data.get("spot", {}).get("price", 3968.5)
    spot_chg = (gold_1h["changePct"] if gold_1h else None) or backup_spot_chg or 0.0

    backup_fx = fetch_backup_fx()
    fx_rate = (fx["price"] if fx and fx["price"] > 10000 else None) or backup_fx or previous_data.get("fx", {}).get("rate", 16350.0)
    fx_chg = fx["changePct"] if fx else 0.0

    candles_1h = gold_1h["candles"][-200:] if gold_1h and gold_1h["candles"] else previous_data.get("candles1h", [])
    candles_1d = gold_1d["candles"][-200:] if gold_1d and gold_1d["candles"] else previous_data.get("candles1d", [])

    spot_idr_gram = (spot_price * fx_rate) / 31.1035

    sell, buyback, antam_source = scrape_antam_prices()
    prev_antam = previous_data.get("antam", {})

    if sell is None:
        if prev_antam.get("sell") and prev_antam.get("spotIdrGram"):
            ratio = spot_idr_gram / prev_antam["spotIdrGram"]
            sell = int(round(prev_antam["sell"] * ratio, -3))
            buyback = int(round(prev_antam.get("buyback", sell * 0.94) * ratio, -3))
            antam_source = "Kalibrasi Spot × USD/IDR"
        else:
            sell = int(round(spot_idr_gram * 1.18, -3))
            buyback = int(round(sell * 0.94, -3))
            antam_source = "Estimasi Spot Lokal"

    if prev_antam.get("date") == today_str:
        yesterday_sell = prev_antam.get("prevDaySell", sell)
    else:
        yesterday_sell = prev_antam.get("sell", sell)

    change_idr = sell - yesterday_sell
    change_pct = ((sell / yesterday_sell) - 1) * 100 if yesterday_sell else 0.0

    history = previous_data.get("antamHistory", [])
    history.append({
        "time": int(now_wib.timestamp()),
        "sell": sell,
        "buyback": buyback,
        "spotIdrGram": round(spot_idr_gram, 0),
    })
    history = history[-360:]

    upcoming_news = fetch_economic_news(now_wib)
    prev_macro = previous_data.get("macro", {})

    def macro_item(res, key, default_val, suffix):
        if res:
            return {"price": res["price"], "changePct": res["changePct"], "suffix": suffix}
        return prev_macro.get(key, {"price": default_val, "changePct": 0.0, "suffix": suffix})

    payload = {
        "updatedAtWib": now_wib.strftime("%Y-%m-%d %H:%M:%S WIB"),
        "timestamp": int(now_wib.timestamp()),
        "spot": {
            "price": round(spot_price, 2),
            "changePct": round(spot_chg, 2),
            "high": max((c["high"] for c in candles_1h[-24:]), default=spot_price),
            "low": min((c["low"] for c in candles_1h[-24:]), default=spot_price),
            "source": "GitHub Actions · Live Market Feed",
        },
        "fx": {
            "rate": round(fx_rate, 0),
            "changePct": round(fx_chg, 2),
            "source": "USD/IDR Otomatis",
        },
        "antam": {
            "date": today_str,
            "sell": sell,
            "buyback": buyback,
            "prevDaySell": yesterday_sell,
            "changeIdr": change_idr,
            "changePct": round(change_pct, 2),
            "spotIdrGram": round(spot_idr_gram, 0),
            "source": antam_source,
        },
        "macro": {
            "dxy": macro_item(dxy, "dxy", 104.15, "pts"),
            "wti": macro_item(wti, "wti", 69.85, "$/bbl"),
            "silver": macro_item(silver, "silver", 31.45, "$/oz"),
            "yield": macro_item(us10y, "yield", 4.28, "%"),
        },
        "candles1h": candles_1h,
        "candles1d": candles_1d,
        "antamHistory": history,
        "events": upcoming_news if upcoming_news else previous_data.get("events", []),
    }

    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    DATA_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Sukses: Antam Rp {sell:,} ({change_idr:+,}) | Spot ${spot_price} | News: {len(payload['events'])}")


if __name__ == "__main__":
    main()
