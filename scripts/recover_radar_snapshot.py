"""按指定交易日恢复短线雷达所需的历史日线快照。"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import random
import shutil
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, time as datetime_time, timedelta, timezone
from pathlib import Path


ENDPOINT = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
SINA_ENDPOINT = "https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData"
SHANGHAI_TIMEZONE = timezone(timedelta(hours=8))


def number(value: object, fallback: float = 0.0) -> float:
    try:
        result = float(value)
        return result if result == result else fallback
    except (TypeError, ValueError):
        return fallback


def market_id(code: str) -> str:
    return "1" if code.startswith("6") else "0"


def eligible_for_recovery(quote: dict, target: date, include_chinext: bool) -> bool:
    code = str(quote.get("code") or "")
    name = str(quote.get("name") or "")
    prefixes = ("00", "30", "60") if include_chinext else ("00", "60")
    if not code.startswith(prefixes) or "ST" in name.upper() or "退" in name:
        return False
    if name.startswith(("N", "C")) or number(quote.get("previousClose")) <= 0:
        return False
    try:
        listed_date = date.fromisoformat(str(quote.get("listedDate")))
    except ValueError:
        return False
    return (target - listed_date).days >= 120


def fetch_history(quote: dict, target: date, attempts: int = 3) -> dict | None:
    code = str(quote["code"])
    target_text = target.isoformat()
    params = {
        "secid": f"{market_id(code)}.{code}",
        "klt": "101",
        "fqt": "0",
        "beg": (target - timedelta(days=45)).strftime("%Y%m%d"),
        "end": target.strftime("%Y%m%d"),
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    }
    url = f"{ENDPOINT}?{urllib.parse.urlencode(params)}"
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(
                url,
                headers={
                    "Accept": "application/json,text/plain,*/*",
                    "Referer": "https://quote.eastmoney.com/",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                },
            )
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = json.loads(response.read().decode("utf-8"))
            lines = ((payload.get("data") or {}).get("klines") or [])
            parsed = [line.split(",") for line in lines]
            target_index = next((index for index, row in enumerate(parsed) if row and row[0] == target_text), -1)
            if target_index < 0:
                return None
            row = parsed[target_index]
            if len(row) < 11:
                return None
            prior_rows = parsed[max(0, target_index - 5):target_index]
            prior_volumes = [number(item[5]) for item in prior_rows if len(item) > 5 and number(item[5]) > 0]
            volume = number(row[5])
            average_volume = sum(prior_volumes) / len(prior_volumes) if prior_volumes else 0
            change_percent = number(row[8])
            previous_close = number(prior_rows[-1][2]) if prior_rows else 0
            if previous_close <= 0 and 1 + change_percent / 100 != 0:
                previous_close = number(row[2]) / (1 + change_percent / 100)

            # 历史接口提供完整日线，但不提供当日资金净流入；其余静态字段沿用盘前证券清单。
            return {
                **quote,
                "price": number(row[2]),
                "changePercent": change_percent,
                "volume": volume,
                "amount": number(row[6]),
                "turnoverRate": number(row[10]),
                "volumeRatio": round(volume / average_volume, 2) if average_volume > 0 else 0,
                "high": number(row[3]),
                "low": number(row[4]),
                "open": number(row[1]),
                "previousClose": round(previous_close, 3),
                "speed": 0,
                "netInflow": 0,
                "quoteTime": int(datetime.combine(target, datetime_time(15, 0), SHANGHAI_TIMEZONE).timestamp()),
            }
        except Exception as error:  # 单只证券短暂失败时退避重试，不中断整批恢复。
            last_error = error
            if attempt + 1 < attempts:
                time.sleep(0.25 * (attempt + 1) + random.random() * 0.2)
    return {"error": str(last_error), "code": code}


def fetch_sina_history(quote: dict, target: date, attempts: int = 3) -> dict | None:
    code = str(quote["code"])
    symbol = f"{'sh' if code.startswith('6') else 'sz'}{code}"
    params = {
        "symbol": symbol,
        "scale": "240",
        "ma": "no",
        "datalen": "80",
    }
    url = f"{SINA_ENDPOINT}?{urllib.parse.urlencode(params)}"
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(
                url,
                headers={
                    "Accept": "application/json,text/plain,*/*",
                    "Referer": "https://finance.sina.com.cn/",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                },
            )
            with urllib.request.urlopen(request, timeout=15) as response:
                rows = json.loads(response.read().decode("utf-8"))
            if not isinstance(rows, list):
                return None
            target_text = target.isoformat()
            target_index = next((index for index, row in enumerate(rows) if row.get("day") == target_text), -1)
            if target_index < 0:
                return None
            row = rows[target_index]
            prior_rows = rows[max(0, target_index - 60):target_index]
            recent_rows = prior_rows[-5:]
            close = number(row.get("close"))
            open_price = number(row.get("open"))
            high = number(row.get("high"))
            low = number(row.get("low"))
            volume = number(row.get("volume"))
            previous_close = number(prior_rows[-1].get("close")) if prior_rows else 0
            prior_volumes = [number(item.get("volume")) for item in recent_rows if number(item.get("volume")) > 0]
            average_volume = sum(prior_volumes) / len(prior_volumes) if prior_volumes else 0
            source_price = number(quote.get("price"))
            total_shares = number(quote.get("marketValue")) / source_price if source_price > 0 else 0
            float_value = number(quote.get("floatMarketValue")) or number(quote.get("marketValue"))
            float_shares = float_value / source_price if source_price > 0 else 0
            average_price = sum(value for value in (open_price, high, low, close) if value > 0) / 4
            change_60d = number(quote.get("change60d"))
            if len(prior_rows) >= 60:
                base_60d = number(prior_rows[-60].get("close"))
                if base_60d > 0:
                    change_60d = (close / base_60d - 1) * 100

            # 备用来源缺少成交额和换手率，使用日线均价、成交量及缓存股本恢复同口径近似值。
            return {
                **quote,
                "price": close,
                "changePercent": round((close / previous_close - 1) * 100, 4) if previous_close > 0 else 0,
                "volume": volume,
                "amount": round(average_price * volume, 2),
                "turnoverRate": round(volume / float_shares * 100, 4) if float_shares > 0 else 0,
                "volumeRatio": round(volume / average_volume, 2) if average_volume > 0 else 0,
                "high": high,
                "low": low,
                "open": open_price,
                "previousClose": previous_close,
                "marketValue": round(total_shares * close, 2) if total_shares > 0 else number(quote.get("marketValue")),
                "floatMarketValue": round(float_shares * close, 2) if float_shares > 0 else float_value,
                "change60d": round(change_60d, 4),
                "speed": 0,
                "netInflow": 0,
                "quoteTime": int(datetime.combine(target, datetime_time(15, 0), SHANGHAI_TIMEZONE).timestamp()),
            }
        except Exception as error:  # 备用来源也按单只证券退避重试，避免偶发连接失败影响整批。
            last_error = error
            if attempt + 1 < attempts:
                time.sleep(0.25 * (attempt + 1) + random.random() * 0.2)
    return {"error": str(last_error), "code": code}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--workers", type=int, default=24)
    parser.add_argument("--rounds", type=int, default=1)
    parser.add_argument("--batch-size", type=int, default=200)
    parser.add_argument("--batch-pause", type=float, default=1.5)
    parser.add_argument("--round-pause", type=float, default=20)
    parser.add_argument("--provider", choices=("eastmoney", "sina"), default="eastmoney")
    parser.add_argument("--include-chinext", action="store_true")
    args = parser.parse_args()

    target = date.fromisoformat(args.date)
    source_path = Path(args.source).resolve()
    output_path = Path(args.output).resolve()
    payload = json.loads(source_path.read_text(encoding="utf-8"))
    source_quotes = (payload.get("snapshot") or {}).get("quotes") or []
    quotes = [item for item in source_quotes if eligible_for_recovery(item, target, args.include_chinext)]
    if not quotes:
        raise SystemExit("源缓存中没有可恢复的证券")

    checkpoint_path = output_path.with_name(f"{output_path.stem}.{target.isoformat()}.checkpoint.json")
    recovered_by_code: dict[str, dict] = {}
    no_data_codes: set[str] = set()
    if checkpoint_path.exists():
        checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
        if checkpoint.get("date") == target.isoformat():
            recovered_by_code = {
                str(item.get("code")): item
                for item in checkpoint.get("quotes") or []
                if item.get("code")
            }
            no_data_codes = {str(code) for code in checkpoint.get("noDataCodes") or []}
            print(f"已载入阶段结果 {len(recovered_by_code)} 条", flush=True)

    workers = min(48, max(4, args.workers))
    rounds = max(1, args.rounds)
    batch_size = max(workers, args.batch_size)
    source_by_code = {str(item["code"]): item for item in quotes}
    fetcher = fetch_sina_history if args.provider == "sina" else fetch_history

    def save_checkpoint() -> None:
        # 历史服务可能在整批中途限制请求；阶段文件保证下一轮只补失败项，不重复消耗已成功额度。
        temporary_checkpoint = checkpoint_path.with_suffix(".tmp")
        temporary_checkpoint.write_text(json.dumps({
            "date": target.isoformat(),
            "quotes": list(recovered_by_code.values()),
            "noDataCodes": sorted(no_data_codes),
        }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        temporary_checkpoint.replace(checkpoint_path)

    for round_index in range(rounds):
        pending = [
            quote for quote in quotes
            if str(quote["code"]) not in recovered_by_code and str(quote["code"]) not in no_data_codes
        ]
        if not pending:
            break
        # 每轮随机调整顺序，避免每次都在同一批证券附近遇到服务限制。
        random.shuffle(pending)
        round_failures: set[str] = set()
        processed = 0
        for start in range(0, len(pending), batch_size):
            batch = pending[start:start + batch_size]
            with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
                futures = {executor.submit(fetcher, quote, target): str(quote["code"]) for quote in batch}
                for future in concurrent.futures.as_completed(futures):
                    code = futures[future]
                    result = future.result()
                    if result and not result.get("error"):
                        recovered_by_code[code] = result
                    elif result and result.get("error"):
                        round_failures.add(code)
                    else:
                        no_data_codes.add(code)
                    processed += 1
            save_checkpoint()
            print(
                f"第 {round_index + 1} 轮已处理 {processed}/{len(pending)}，"
                f"累计恢复 {len(recovered_by_code)}，本轮失败 {len(round_failures)}",
                flush=True,
            )
            if start + batch_size < len(pending) and args.batch_pause > 0:
                time.sleep(args.batch_pause)
        if round_index + 1 < rounds and round_failures:
            time.sleep(max(0, args.round_pause))

    recovered = list(recovered_by_code.values())
    minimum_required = max(1000, int(len(quotes) * 0.8))
    if len(recovered) < minimum_required:
        raise SystemExit(
            f"恢复完整度不足：累计取得 {len(recovered)}/{len(quotes)} 条，"
            f"阶段结果已保存至 {checkpoint_path}，未写入正式缓存"
        )

    recovered.sort(key=lambda item: item["code"])
    snapshot = {
        "asOfDate": target.isoformat(),
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "source": "公开历史日线恢复（成交额与换手率为估算，资金净流入字段不可用）"
        if args.provider == "sina"
        else "公开历史日线恢复（资金净流入字段不可用）",
        "stale": False,
        "recovered": True,
        "quotes": recovered,
    }
    output_payload = {"snapshot": snapshot, "news": []}
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if output_path.exists():
        backup_name = f"{output_path.stem}.before-recovery-{datetime.now().strftime('%Y%m%d-%H%M%S')}{output_path.suffix}"
        shutil.copy2(output_path, output_path.with_name(backup_name))
    temporary = output_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(output_payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(output_path)
    checkpoint_path.unlink(missing_ok=True)
    print(json.dumps({
        "date": target.isoformat(),
        "requested": len(quotes),
        "recovered": len(recovered),
        "failed": len(quotes) - len(recovered) - len(no_data_codes),
        "output": str(output_path),
    }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
