use crate::commands::shared::home_dir;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize, Clone)]
pub struct ModelUsage {
    pub source: String,
    pub model: String,
    pub sessions: u32,
    #[serde(rename = "inputTokens")]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: u64,
    #[serde(rename = "costUsd")]
    pub cost_usd: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct DailyCost {
    pub date: String,
    #[serde(rename = "costUsd")]
    pub cost_usd: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct AnalyticsData {
    #[serde(rename = "totalCostUsd")]
    pub total_cost_usd: f64,
    #[serde(rename = "totalSessions")]
    pub total_sessions: u32,
    #[serde(rename = "totalInputTokens")]
    pub total_input_tokens: u64,
    #[serde(rename = "totalOutputTokens")]
    pub total_output_tokens: u64,
    #[serde(rename = "modelUsage")]
    pub model_usage: Vec<ModelUsage>,
    #[serde(rename = "dailyCosts")]
    pub daily_costs: Vec<DailyCost>,
}

/// Shape of ~/.claude/cost-tally.json entries
#[derive(Debug, Deserialize)]
struct CostTallyEntry {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    cost: Option<f64>,
    #[serde(default, alias = "costUsd")]
    cost_usd: Option<f64>,
    #[serde(default)]
    date: Option<String>,
    #[serde(default, alias = "inputTokens")]
    input_tokens: Option<u64>,
    #[serde(default, alias = "outputTokens")]
    output_tokens: Option<u64>,
    #[serde(default)]
    sessions: Option<u32>,
}

#[tauri::command]
pub fn read_usage_analytics() -> String {
    let home = match home_dir() {
        Some(h) => h,
        None => return empty_analytics(),
    };

    let claude_dir = PathBuf::from(&home).join(".claude");

    // Try reading cost-tally.json
    let cost_tally_path = claude_dir.join("cost-tally.json");
    let cost_entries = read_cost_tally(&cost_tally_path);

    // Aggregate data
    let mut total_cost: f64 = 0.0;
    let mut total_sessions: u32 = 0;
    let mut total_input: u64 = 0;
    let mut total_output: u64 = 0;

    let mut model_map: HashMap<String, ModelUsage> = HashMap::new();
    let mut daily_map: HashMap<String, f64> = HashMap::new();

    for entry in &cost_entries {
        let cost = entry.cost_usd.or(entry.cost).unwrap_or(0.0);
        let model = entry.model.clone().unwrap_or_else(|| "unknown".to_string());
        let input = entry.input_tokens.unwrap_or(0);
        let output = entry.output_tokens.unwrap_or(0);
        let sessions = entry.sessions.unwrap_or(1);
        let source = "claude-cli".to_string();

        total_cost += cost;
        total_sessions += sessions;
        total_input += input;
        total_output += output;

        let key = format!("{}::{}", source, model);
        let usage = model_map.entry(key).or_insert(ModelUsage {
            source: source.clone(),
            model: model.clone(),
            sessions: 0,
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0.0,
        });
        usage.source = source.clone();
        usage.sessions += sessions;
        usage.input_tokens += input;
        usage.output_tokens += output;
        usage.cost_usd += cost;

        if let Some(date) = &entry.date {
            *daily_map.entry(date.clone()).or_insert(0.0) += cost;
        }
    }

    // Ingest ~/.packetade/usage.jsonl (written by API agents)
    let usage_jsonl_path = PathBuf::from(&home)
        .join(crate::core::brand::DATA_DIR_NAME)
        .join("usage.jsonl");
    if let Ok(contents) = fs::read_to_string(&usage_jsonl_path) {
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let entry: crate::commands::usage::UsageEntry = match serde_json::from_str(line) {
                Ok(e) => e,
                Err(_) => continue,
            };

            let cost = entry.cost_usd;
            let input = entry.input_tokens;
            let output = entry.output_tokens;
            let sessions: u32 = 1;

            total_cost += cost;
            total_sessions += sessions;
            total_input += input;
            total_output += output;

            let key = format!("{}::{}", entry.source, entry.model);
            let usage = model_map.entry(key).or_insert(ModelUsage {
                source: entry.source.clone(),
                model: entry.model.clone(),
                sessions: 0,
                input_tokens: 0,
                output_tokens: 0,
                cost_usd: 0.0,
            });
            usage.source = entry.source.clone();
            usage.sessions += sessions;
            usage.input_tokens += input;
            usage.output_tokens += output;
            usage.cost_usd += cost;

            // Daily date = first 10 chars of ISO 8601 timestamp, or today as fallback
            let date = if entry.ts.len() >= 10 {
                entry.ts[..10].to_string()
            } else {
                today_date_string()
            };
            *daily_map.entry(date).or_insert(0.0) += cost;
        }
    }

    // Ingest ~/.codex/sessions/*.jsonl (written by Codex CLI)
    let codex_sessions_dir = PathBuf::from(&home).join(".codex").join("sessions");
    if codex_sessions_dir.exists() {
        let mut codex_files: Vec<PathBuf> = Vec::new();
        collect_jsonl_files_recursive(&codex_sessions_dir, &mut codex_files);

        for path in codex_files {
            let contents = match fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };

            // Per session: aggregate the latest token_count (cumulative totals), latest model, latest date.
            let mut latest_model: Option<String> = None;
            let mut latest_input: u64 = 0;
            let mut latest_output: u64 = 0;
            let mut latest_cached: u64 = 0;
            let mut latest_date: Option<String> = None;
            let mut has_tokens = false;

            for line in contents.lines() {
                let parsed: serde_json::Value = match serde_json::from_str(line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let top_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");

                if top_type == "event_msg" {
                    if let Some(payload) = parsed.get("payload") {
                        let inner_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if inner_type == "token_count" {
                            has_tokens = true;
                            let info = payload.get("info");
                            let usage = info.and_then(|i| i.get("total_token_usage"));

                            latest_input = usage
                                .and_then(|u| u.get("input_tokens"))
                                .and_then(|v| v.as_u64())
                                .unwrap_or(latest_input);
                            latest_output = usage
                                .and_then(|u| u.get("output_tokens"))
                                .and_then(|v| v.as_u64())
                                .unwrap_or(latest_output);
                            latest_cached = usage
                                .and_then(|u| u.get("cached_input_tokens"))
                                .or_else(|| usage.and_then(|u| u.get("cached_tokens")))
                                .and_then(|v| v.as_u64())
                                .unwrap_or(latest_cached);

                            if let Some(ts) = parsed.get("timestamp").and_then(|v| v.as_str()) {
                                if ts.len() >= 10 {
                                    latest_date = Some(ts[..10].to_string());
                                }
                            }
                        }
                    }
                } else if top_type == "turn_context" {
                    if let Some(payload) = parsed.get("payload") {
                        if let Some(model) = payload.get("model").and_then(|v| v.as_str()) {
                            latest_model = Some(model.to_string());
                        }
                    }
                }
            }

            if !has_tokens {
                continue;
            }

            let model = latest_model.unwrap_or_else(|| "unknown".to_string());
            let cost = crate::commands::pricing::calculate_cost(
                &model,
                latest_input,
                latest_output,
                latest_cached,
                0,
            );
            let source = "codex".to_string();
            let sessions: u32 = 1;

            total_cost += cost;
            total_sessions += sessions;
            total_input += latest_input;
            total_output += latest_output;

            let key = format!("{}::{}", source, model);
            let usage = model_map.entry(key).or_insert(ModelUsage {
                source: source.clone(),
                model: model.clone(),
                sessions: 0,
                input_tokens: 0,
                output_tokens: 0,
                cost_usd: 0.0,
            });
            usage.source = source.clone();
            usage.sessions += sessions;
            usage.input_tokens += latest_input;
            usage.output_tokens += latest_output;
            usage.cost_usd += cost;

            if let Some(date) = latest_date {
                *daily_map.entry(date).or_insert(0.0) += cost;
            }
        }
    }

    // Also try reading stats-cache.json for additional data
    let stats_path = claude_dir.join("stats-cache.json");
    if let Ok(contents) = fs::read_to_string(&stats_path) {
        if let Ok(stats) = serde_json::from_str::<serde_json::Value>(&contents) {
            // Extract any additional session/cost data from stats cache
            if let Some(total) = stats.get("totalCost").and_then(|v| v.as_f64()) {
                if total > total_cost {
                    total_cost = total;
                }
            }
            if let Some(count) = stats.get("totalSessions").and_then(|v| v.as_u64()) {
                if count as u32 > total_sessions {
                    total_sessions = count as u32;
                }
            }
        }
    }

    let mut model_usage: Vec<ModelUsage> = model_map.into_values().collect();
    model_usage.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut daily_costs: Vec<DailyCost> = daily_map
        .into_iter()
        .map(|(date, cost_usd)| DailyCost { date, cost_usd })
        .collect();
    daily_costs.sort_by(|a, b| a.date.cmp(&b.date));

    // Keep last 30 days
    if daily_costs.len() > 30 {
        daily_costs = daily_costs.split_off(daily_costs.len() - 30);
    }

    let data = AnalyticsData {
        total_cost_usd: total_cost,
        total_sessions,
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        model_usage,
        daily_costs,
    };

    serde_json::to_string(&data).unwrap_or_else(|_| empty_analytics())
}

fn read_cost_tally(path: &PathBuf) -> Vec<CostTallyEntry> {
    let contents = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    // Could be an array or an object with entries
    if let Ok(entries) = serde_json::from_str::<Vec<CostTallyEntry>>(&contents) {
        return entries;
    }

    // Try as a map of date -> entry
    if let Ok(map) = serde_json::from_str::<HashMap<String, serde_json::Value>>(&contents) {
        let mut entries = Vec::new();
        for (date, value) in map {
            if let Ok(mut entry) = serde_json::from_value::<CostTallyEntry>(value) {
                if entry.date.is_none() {
                    entry.date = Some(date);
                }
                entries.push(entry);
            }
        }
        return entries;
    }

    vec![]
}

fn empty_analytics() -> String {
    r#"{"totalCostUsd":0,"totalSessions":0,"totalInputTokens":0,"totalOutputTokens":0,"modelUsage":[],"dailyCosts":[]}"#.to_string()
}

fn collect_jsonl_files_recursive(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files_recursive(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn today_date_string() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Convert to YYYY-MM-DD in UTC. Simple manual conversion to avoid extra deps.
    let days = (secs / 86_400) as i64;
    let (y, m, d) = days_to_ymd(days);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

fn days_to_ymd(days_since_epoch: i64) -> (i32, u32, u32) {
    // Days since 1970-01-01 -> Gregorian Y/M/D. Algorithm from Howard Hinnant.
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = y + if m <= 2 { 1 } else { 0 };
    (y as i32, m as u32, d as u32)
}
