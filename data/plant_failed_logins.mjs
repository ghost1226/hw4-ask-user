/**
 * Plants synthetic demo data for Demo 1 (W2-3/W2-4).
 *
 * Writes `data/failed_logins.csv` with exactly 200 fake failed-login rows.
 * All users are @contoso.com; all IPs are RFC 5737 documentation addresses
 * (203.0.113.0/24). Nothing here is real.
 *
 * Three bursts are planted so the chosen alert threshold is provable:
 *
 *   IP               burst                       5/10   10/30   20/60
 *   203.0.113.10     7 failures in 6 minutes     yes     no      no
 *   203.0.113.20    12 failures in 22 minutes    yes     yes     no
 *   203.0.113.30    25 failures in 48 minutes    yes     yes     yes
 *
 * The remaining 156 rows are one failure each from distinct IPs, so no
 * threshold flags any of them.
 *
 * Run: node data/plant_failed_logins.mjs
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, "failed_logins.csv");

const BASE = Date.UTC(2024, 5, 3, 2, 0, 0); // 2024-06-03T02:00:00Z
const at = (minutes) => new Date(BASE + minutes * 60_000).toISOString();

const rows = [];

// --- Burst A: 203.0.113.10, 7 failures over 6 minutes (flagged at 5/10 only)
for (let i = 0; i < 7; i++) {
  rows.push({ ts: at(i), user: `user${i}@contoso.com`, ip: "203.0.113.10" });
}

// --- Burst B: 203.0.113.20, 12 failures over 22 minutes (5/10 and 10/30)
for (let i = 0; i < 12; i++) {
  rows.push({ ts: at(60 + i * 2), user: `user${i}@contoso.com`, ip: "203.0.113.20" });
}

// --- Burst C: 203.0.113.30, 25 failures over 48 minutes (all three)
for (let i = 0; i < 25; i++) {
  rows.push({ ts: at(120 + i * 2), user: `user${i}@contoso.com`, ip: "203.0.113.30" });
}

// --- Noise: 156 single failures from distinct IPs, spread over time
for (let j = 0; j < 156; j++) {
  rows.push({
    ts: at(180 + j * 7),
    user: `user${j % 40}@contoso.com`,
    ip: `203.0.113.${100 + j}`,
  });
}

if (rows.length !== 200) throw new Error(`expected 200 rows, got ${rows.length}`);

const csv = ["timestamp,username,source_ip,outcome"]
  .concat(rows.map((r) => `${r.ts},${r.user},${r.ip},failure`))
  .join("\n")
  .concat("\n");

writeFileSync(outFile, csv, "utf8");
console.log(`wrote ${rows.length} rows to ${outFile}`);
