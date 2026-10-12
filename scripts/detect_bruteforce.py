#!/usr/bin/env python3
"""
Brute-force detector for failed_logins.csv.
Flags an IP if it has >= THRESHOLD failures within any WINDOW_MINUTES window.
"""
import csv
import os
from datetime import datetime, timedelta, timezone
from collections import defaultdict

THRESHOLD = int(os.environ.get("BF_THRESHOLD", "10"))
WINDOW_MINUTES = int(os.environ.get("BF_WINDOW", "30"))

def parse_ts(ts: str) -> datetime:
    """Parse ISO 8601 timestamp with trailing Z."""
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))

def main():
    ip_failures = defaultdict(list)

    with open("data/failed_logins.csv", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row["outcome"].lower() != "failure":
                continue
            ip = row["source_ip"]
            ts = parse_ts(row["timestamp"])
            ip_failures[ip].append(ts)

    flagged = []
    for ip, times in ip_failures.items():
        times.sort()
        # Sliding window: count failures within WINDOW_MINUTES
        for i in range(len(times)):
            window_end = times[i] + timedelta(minutes=WINDOW_MINUTES)
            count = sum(1 for t in times if times[i] <= t <= window_end)
            if count >= THRESHOLD:
                flagged.append(ip)
                break

    print(f"Threshold: {THRESHOLD} failures in {WINDOW_MINUTES} minutes")
    print(f"Flagged IPs ({len(flagged)}):")
    for ip in sorted(flagged):
        print(f"  - {ip}")

    # Debug: show counts per IP
    print("\nAll IP failure counts:")
    for ip in sorted(ip_failures):
        print(f"  {ip}: {len(ip_failures[ip])}")

if __name__ == "__main__":
    main()
