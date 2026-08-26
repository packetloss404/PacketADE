#!/usr/bin/env node
/**
 * cache-hit-rate.mjs — CE4 instrumentation (temporary, not a product feature).
 *
 * Reads `~/.packetbench/usage.jsonl` and prints the prompt-cache token mix per
 * model. Its only job is to prove CE6 (Anthropic automatic prompt caching)
 * actually took effect: prompt caching fails **silently** when the prefix is
 * below a model's minimum cacheable length, so "it compiled" proves nothing and
 * a non-zero, sustained cache-read share is the acceptance signal.
 *
 *   hit rate = cache_read / (input + cache_read + cache_write)
 *
 * Hit rate is rate-independent, so it survives a stale pricing table — which is
 * exactly why it is the acceptance signal rather than dollars.
 *
 * Token semantics: `usage.jsonl` stores each vendor's own numbers. OpenAI-family
 * vendors report `input_tokens` as a SUPERSET already containing `cache_read`;
 * Anthropic's buckets are disjoint. Which is which is recorded per vendor in
 * `shared/model-pricing.json` as `inputIncludesCacheRead`, read below, so the
 * denominator means the same thing for every row.
 *
 * Usage:
 *   node scripts/cache-hit-rate.mjs [--since 2026-07-31] [--file <path>]
 *
 * Expected reading: ~0% before CE6 (caching was off), high and stable after.
 * Delete this script once CE6 is verified — do not let it grow into a
 * reporting surface. See dev/cost-efficiency-loop.md.
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

const ROUTE_PREFIXES = [
  "anthropic/",
  "openai/",
  "google/",
  "openrouter/",
  "ollama/",
  "ollama:",
  "local/",
];

/** Mirrors `candidatesFor` in src/lib/modelPricing.ts and `candidates` in pricing.rs. */
function candidatesFor(model) {
  const normalized = String(model ?? "")
    .trim()
    .toLowerCase();
  const base = [normalized];
  for (const route of ROUTE_PREFIXES) {
    if (normalized.startsWith(route)) {
      const rest = normalized.slice(route.length);
      if (rest) base.push(rest);
    }
  }
  const out = [];
  for (const candidate of base) {
    if (!out.includes(candidate)) out.push(candidate);
    const stripped = candidate.replace(/-\d{8}$/, "");
    if (stripped !== candidate && !out.includes(stripped)) out.push(stripped);
  }
  return out;
}

/**
 * Map a model id to its vendor's `inputIncludesCacheRead` flag, using the same
 * first-match-wins rules as the two cost engines. Unknown models are assumed
 * disjoint (the conservative reading — it never inflates the hit rate).
 */
function buildSemantics() {
  const table = JSON.parse(readFileSync(join(repoRoot, "shared", "model-pricing.json"), "utf8"));
  const rows = table.models ?? [];
  const matches = (entry, candidates) =>
    candidates.some(
      (c) =>
        (entry.match?.equals ?? []).some((r) => c === r) ||
        (entry.match?.prefix ?? []).some((r) => c.startsWith(r)) ||
        (entry.match?.contains ?? []).some((r) => c.includes(r)),
    );
  return (model) => {
    const candidates = candidatesFor(model);
    const entry = rows.find((e) => matches(e, candidates));
    return Boolean(entry?.inputIncludesCacheRead);
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node scripts/cache-hit-rate.mjs [--since YYYY-MM-DD] [--file <path>]");
    return;
  }

  let raw;
  try {
    raw = readFileSync(args.file, "utf8");
  } catch {
    console.error(`No usage log at ${args.file} — run at least one API-agent turn first.`);
    process.exitCode = 1;
    return;
  }

  const inputIncludesCacheRead = buildSemantics();
  const byModel = new Map();
  let skipped = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    if (args.since && String(entry.ts ?? "") < args.since) continue;

    const model = entry.model ?? "(unknown)";
    const bucket = byModel.get(model) ?? {
      turns: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
    };
    const cacheRead = entry.cache_read ?? 0;
    const rawInput = entry.input_tokens ?? 0;
    bucket.turns++;
    // Normalise to disjoint buckets so the denominator is comparable across
    // vendors (and is not inflated by counting cache reads twice).
    bucket.input += inputIncludesCacheRead(model) ? Math.max(0, rawInput - cacheRead) : rawInput;
    bucket.cacheRead += cacheRead;
    bucket.cacheWrite += entry.cache_write ?? 0;
    bucket.output += entry.output_tokens ?? 0;
    byModel.set(model, bucket);
  }

  if (byModel.size === 0) {
    console.log(`No usage rows${args.since ? ` since ${args.since}` : ""} in ${args.file}.`);
    return;
  }

  const rows = [...byModel.entries()]
    .map(([model, b]) => {
      const promptTokens = b.input + b.cacheRead + b.cacheWrite;
      return {
        model,
        turns: b.turns,
        input: b.input,
        cacheRead: b.cacheRead,
        cacheWrite: b.cacheWrite,
        output: b.output,
        hit: promptTokens > 0 ? b.cacheRead / promptTokens : 0,
      };
    })
    .sort((a, b) => b.cacheRead + b.input - (a.cacheRead + a.input));

  const pad = (value, width) => String(value).padStart(width);
  console.log(`Prompt-cache mix from ${args.file}${args.since ? ` since ${args.since}` : ""}\n`);
  console.log(
    `${"model".padEnd(34)}${pad("turns", 7)}${pad("input", 12)}${pad("cache_rd", 12)}${pad("cache_wr", 12)}${pad("output", 12)}${pad("hit", 8)}`,
  );
  const totals = { turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const row of rows) {
    totals.turns += row.turns;
    totals.input += row.input;
    totals.cacheRead += row.cacheRead;
    totals.cacheWrite += row.cacheWrite;
    totals.output += row.output;
    console.log(
      `${row.model.slice(0, 33).padEnd(34)}${pad(row.turns, 7)}${pad(row.input, 12)}${pad(row.cacheRead, 12)}${pad(row.cacheWrite, 12)}${pad(row.output, 12)}${pad(`${(row.hit * 100).toFixed(1)}%`, 8)}`,
    );
  }
  const promptTotal = totals.input + totals.cacheRead + totals.cacheWrite;
  const overall = promptTotal > 0 ? totals.cacheRead / promptTotal : 0;
  console.log(
    `${"ALL".padEnd(34)}${pad(totals.turns, 7)}${pad(totals.input, 12)}${pad(totals.cacheRead, 12)}${pad(totals.cacheWrite, 12)}${pad(totals.output, 12)}${pad(`${(overall * 100).toFixed(1)}%`, 8)}`,
  );

  if (skipped > 0) console.log(`\n(${skipped} unparseable line(s) skipped)`);
  if (totals.cacheRead === 0) {
    console.log(
      "\ncache_read is 0 across every row. Either no turn has run since CE6 shipped, or the\n" +
        "prefix is below the model's minimum cacheable length (1,024-4,096 tokens depending\n" +
        "on the model) — prompt caching fails silently in that case.",
    );
  }
  console.log(
    "\nNote: enabling/disabling MCP servers mid-session changes the tools array and resets\n" +
      "the cache, so hit rates are noisier in MCP-heavy projects.",
  );
}

main();
