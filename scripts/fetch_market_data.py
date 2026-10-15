"""下载个人研究所需的真实日频行情并写入本地缓存。"""

from __future__ import annotations

import argparse
import json
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path


DEFAULT_CODES = [
    "600000",
    "600036",
    "600519",
    "601318",
    "601899",
    "000001",
    "000333",
    "000651",
    "000858",
    "002594",
    "300750",
    "300760",
]

ENDPOINT = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"


def market_symbol(code: str) -> str:
    prefix = "sh" if code.startswith(("6", "68", "9")) else "sz"
    return f"{prefix}{code}"


def number(value: str) -> float:
    if value in ("", "-"):
        return 0.0
    return float(value)


def fetch_period(code: str, start: str, end: str) -> tuple[str, list[dict]]:
    symbol = market_symbol(code)
    params = {"param": f"{symbol},day,{start},{end},640,qfq"}
    url = f"{ENDPOINT}?{urllib.parse.urlencode(params)}"
    last_error: Exception | None = None

    for attempt in range(3):
        try:
            request = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                    "Referer": "https://gu.qq.com/",
                    "Accept": "application/json,text/plain,*/*",
                    "Connection": "close",
                },
            )
            with urllib.request.urlopen(request, timeout=25) as response:
                payload = json.loads(response.read().decode("utf-8"))
            data = (payload.get("data") or {}).get(symbol)
            if not data:
                raise RuntimeError(f"{code} 没有返回可用日线")
            lines = data.get("qfqday") or data.get("day") or []
            quote = (data.get("qt") or {}).get(symbol) or []
            name = quote[1] if len(quote) > 1 else code
            if not lines:
                return name, []

            rows = []
            for values in lines:
                if len(values) < 6:
                    continue
                volume_lots = number(values[5])
                close = number(values[2])
                rows.append(
                    {
                        "date": values[0],
                        "open": number(values[1]),
                        "close": close,
                        "high": number(values[3]),
                        "low": number(values[4]),
                        "volume": volume_lots * 100,
                        "amount": volume_lots * 100 * close,
                        "turn": 0.0,
                        "tradable": volume_lots > 0,
                    }
                )
            return name, rows
        except Exception as exc:  # 网络短暂不稳定时最多重试三次。
            last_error = exc
            time.sleep(1.2 * (attempt + 1))

    raise RuntimeError(f"{code} 更新失败：{last_error}")


def fetch_code(code: str, start: str, end: str) -> tuple[dict, list[dict]]:
    start_date = date.fromisoformat(start)
    requested_end = date.fromisoformat(end)
    end_date = min(requested_end, datetime.now(timezone.utc).date())
    name = code
    rows_by_date: dict[str, dict] = {}

    year = start_date.year
    while year <= end_date.year:
        period_start = max(start_date, date(year, 1, 1)).isoformat()
        period_end = min(end_date, date(min(year + 1, end_date.year), 12, 31)).isoformat()
        period_name, period_rows = fetch_period(code, period_start, period_end)
        name = period_name or name
        rows_by_date.update({row["date"]: row for row in period_rows})
        time.sleep(0.18)
        year += 2

    rows = [rows_by_date[key] for key in sorted(rows_by_date)]
    if len(rows) < 120:
        raise RuntimeError(f"{code} 有效日线不足 120 条")
    asset = {
        "id": code,
        "name": name,
        "industry": "待补充",
        "market": "SH" if market_symbol(code).startswith("sh") else "SZ",
    }
    return asset, rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--codes", default=",".join(DEFAULT_CODES))
    parser.add_argument("--start", default="2022-01-01")
    parser.add_argument("--end", default="2050-01-01")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    codes = [item.strip() for item in args.codes.split(",") if item.strip()]
    if not codes or len(codes) > 40 or any(len(code) != 6 or not code.isdigit() for code in codes):
        raise SystemExit("证券代码必须是 1 至 40 个六位数字")

    assets = []
    series = {}
    for index, code in enumerate(codes, start=1):
        asset, rows = fetch_code(code, args.start, args.end)
        assets.append(asset)
        series[code] = rows
        print(f"[{index}/{len(codes)}] {code} {asset['name']} {len(rows)} 条", flush=True)
        time.sleep(0.12)

    common_start = max(rows[0]["date"] for rows in series.values())
    common_end = min(rows[-1]["date"] for rows in series.values())
    fetched_at = datetime.now(timezone.utc).isoformat()
    payload = {
        "metadata": {
            "id": f"real-daily-{common_end.replace('-', '')}",
            "name": "真实 A 股日频数据",
            "kind": "real",
            "source": "腾讯证券公开行情",
            "fetchedAt": fetched_at,
            "startDate": common_start,
            "endDate": common_end,
            "researchStartDate": common_start,
            "instrumentCount": len(assets),
            "status": "ready",
            "priceMode": "前复权",
            "note": "真实前复权日行情；当前技术验证池由固定代码组成，历史结果存在范围选择偏差，成交金额为价格与成交量估算值。",
        },
        "assets": assets,
        "series": series,
    }

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(output)
    print(json.dumps(payload["metadata"], ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
