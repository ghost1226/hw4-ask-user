#!/usr/bin/env python3
"""Flag brute-force attempts in failed_logins.csv from a CSV of failed logins."""

import csv
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path


def load_failures(csv_path: Path) -> dict[str, list[datetime]]:
    """Read CSV and return a dict mapping source_ip to sorted failure timestamps."""
    rows_by_ip = defaultdict(list)
    with csv_path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            ip = row["source_ip"]
            ts = datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00"))
            rows_by_ip[ip].append(ts)

    for ip in rows_by_ip:
        rows_by_ip[ip].sort()
    return rows_by_ip


def is_flagged(timestamps: list[datetime], count: int, window: timedelta) -> bool:
    """Return True if any sliding window of `window` contains >= `count` timestamps."""
    for i, start in enumerate(timestamps):
        window_end = start + window
        # Count how many timestamps fall within [start, window_end]
        # inclusive of boundaries to avoid off-by-one surprises
        in_window = sum(1 for t in timestamps[i:] if t <= window_end)
        if in_window >= count:
            return True
    return False


def main() -> None:
    csv_path = Path(__file__).resolve().parent.parent / "data" / "failed_logins.csv"
    threshold = (10, timedelta(minutes=30))  # (count, window) — set by user choice
    count, window = threshold

    failures_by_ip = load_failures(csv_path)
    flagged: list[str] = []

    for ip, timestamps in failures_by_ip.items():
        if len(timestamps) < count:
            continue
        if is_flagged(timestamps, count, window):
            flagged.append(ip)

    print(f"Threshold: {count} failures in {window}")
    print(f"Flagged IPs ({len(flagged)}):")
    for ip in flagged:
        print(f"  - {ip}")


if __name__ == "__main__":
    main()
