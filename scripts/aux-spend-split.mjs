#!/usr/bin/env node
/**
 * aux-spend-split.mjs — LM7 instrumentation (temporary, not a product feature;
 * same posture as cache-hit-rate.mjs / CE3–CE4).
 *
 * Reads `~/.packetbench/usage.jsonl`, keeps `source == "aux"` rows, and splits
 * them into:
 *   local   — provider == "ollama" OR cost_usd == 0 (the provider field only
 *             exists on rows written after 2026-08; the zero-cost fallback
 *             catches older local rows)
 *   metered — everything else
 *
 * Per task class (agent_id) it prints counts / tokens / dollars, then a
 * MODELLED figure: what the local rows would have cost had they run on the
 * cheapest cloud model the aux router can auto-select, priced from
 * `shared/model-pricing.json`. The measured and modelled numbers are labelled
 * as such — do not paste the modelled one anywhere as a measurement.
 *
 * Usage:
 *   node scripts/aux-spend-split.mjs [--since 2026-08-01] [--file <path>]
 *
 * No UI counterpart on purpose: the cost dashboard was removed 2026-07-31 and
 * is not coming back. Delete this script once LM7's number is recorded.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { since: null, file: join(homedir(), ".packetbench", "usage.jsonl") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--since") args.since = argv[++i];
    else if (argv[i] === "--file") args.file = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage: node scripts/aux-spend-split.mjs [--since YYYY-MM-DD] [--file <usage.jsonl>]");
  process.exit(0);
}

// --- pricing ---------------------------------------------------------------

const pricing = JSON.parse(
  readFileSync(join(repoRoot, "shared", "model-pricing.json"), "utf8"),
);

const ROUTE_PREFIXES = ["anthropic/", "openai/", "google/", "meta-llama/", "minimax/"];

function candidatesFor(modelId) {
  const base = String(modelId ?? "").trim().toLowerCase();
  const out = [base];
  for (const prefix of ROUTE_PREFIXES) {
    if (base.startsWith(prefix)) out.push(base.slice(prefix.length));
  }
  const datestripped = base.replace(/-\d{8}$/, "");
  if (!out.includes(datestripped)) out.push(datestripped);
  return out;
}

function ratesForEntry(entry) {
  if (entry.rates) return entry.rates;
  if (Array.isArray(entry.schedule) && entry.schedule.length > 0) {
    // Latest schedule row = current rate. Good enough for a modelled figure.
    return entry.schedule[entry.schedule.length - 1].rates;
  }
  return null;
}

function findRates(modelId) {
  const candidates = candidatesFor(modelId);
  for (const entry of pricing.models) {
    const match = entry.match ?? {};
    for (const candidate of candidates) {
      if ((match.equals ?? []).includes(candidate)) return ratesForEntry(entry);
      if ((match.prefix ?? []).some((p) => candidate.startsWith(p))) return ratesForEntry(entry);
      if ((match.contains ?? []).some((c) => candidate.includes(c))) return ratesForEntry(entry);
    }
  }
  return null;
}

function costUsd(rates, inputTokens, outputTokens) {
  return (inputTokens * rates.input + outputTokens * rates.output) / 1e6;
}

/**
 * The metered aux candidates' default models — mirrors AUX_PROVIDERS in
 * src-tauri/src/core/aux_llm.rs (ollama excluded: it is what we are
 * counterfactualising away).
 */
const CLOUD_AUX_DEFAULT_MODELS = ["claude-haiku-4-5", "o4-mini", "MiniMax-M2", "anthropic/claude-haiku-4-5"];

function cheapestCloudRates() {
  let best = null;
  let bestModel = null;
  // Rank on the aux router's representative workload (20k in / 1.5k out).
  for (const model of CLOUD_AUX_DEFAULT_MODELS) {
    const rates = findRates(model);
    if (!rates) continue;
    const ref = costUsd(rates, 20_000, 1_500);
    if (best === null || ref < best.ref) {
      best = { rates, ref };
      bestModel = model;
    }
  }
  return best ? { rates: best.rates, model: bestModel } : null;
}

// --- ledger ----------------------------------------------------------------

let raw;
try {
  raw = readFileSync(args.file, "utf8");
} catch {
  console.error(`No usage ledger at ${args.file}`);
  process.exit(1);
}

const rows = [];
for (const line of raw.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  try {
    const row = JSON.parse(trimmed);
    if (row.source !== "aux") continue;
    if (args.since && String(row.ts ?? "") < args.since) continue;
    rows.push(row);
  } catch {
    // Skip torn/corrupt lines; append-only ledgers can have one at the tail.
  }
}

const isLocal = (row) => row.provider === "ollama" || Number(row.cost_usd ?? 0) === 0;

const byClass = new Map();
for (const row of rows) {
  const key = row.agent_id ?? "(unknown)";
  if (!byClass.has(key)) {
    byClass.set(key, {
      local: { count: 0, input: 0, output: 0, usd: 0 },
      metered: { count: 0, input: 0, output: 0, usd: 0 },
    });
  }
  const bucket = byClass.get(key)[isLocal(row) ? "local" : "metered"];
  bucket.count += 1;
  bucket.input += Number(row.input_tokens ?? 0);
  bucket.output += Number(row.output_tokens ?? 0);
  bucket.usd += Number(row.cost_usd ?? 0);
}

// --- report ----------------------------------------------------------------

const fmtUsd = (v) => `$${v.toFixed(4)}`;
const fmtTok = (v) => v.toLocaleString("en-US");

console.log(`aux rows: ${rows.length}${args.since ? ` (since ${args.since})` : ""}\n`);
console.log(
  "task class".padEnd(26) +
    "bucket".padEnd(9) +
    "turns".padStart(7) +
    "in tok".padStart(12) +
    "out tok".padStart(11) +
    "USD (measured)".padStart(16),
);

let totalLocal = { count: 0, input: 0, output: 0, usd: 0 };
let totalMetered = { count: 0, input: 0, output: 0, usd: 0 };

for (const [taskClass, buckets] of [...byClass.entries()].sort()) {
  for (const kind of ["local", "metered"]) {
    const b = buckets[kind];
    if (b.count === 0) continue;
    console.log(
      taskClass.padEnd(26) +
        kind.padEnd(9) +
        String(b.count).padStart(7) +
        fmtTok(b.input).padStart(12) +
        fmtTok(b.output).padStart(11) +
        fmtUsd(b.usd).padStart(16),
    );
    const total = kind === "local" ? totalLocal : totalMetered;
    total.count += b.count;
    total.input += b.input;
    total.output += b.output;
    total.usd += b.usd;
  }
}

console.log("");
console.log(`local   (measured): ${totalLocal.count} turns, ${fmtUsd(totalLocal.usd)}`);
console.log(`metered (measured): ${totalMetered.count} turns, ${fmtUsd(totalMetered.usd)}`);

const cheapest = cheapestCloudRates();
if (cheapest && totalLocal.count > 0) {
  const modelled = costUsd(cheapest.rates, totalLocal.input, totalLocal.output);
  console.log(
    `local rows re-priced at cheapest cloud aux model (${cheapest.model}): ` +
      `${fmtUsd(modelled)} (MODELLED, not measured)`,
  );
} else if (totalLocal.count === 0) {
  console.log("no local rows to counterfactualise — modelled figure skipped");
}
