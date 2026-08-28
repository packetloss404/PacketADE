//! VADER sentiment scoring for dictation transcripts.
//!
//! Dictation's `entries` table has always had a `sentiment REAL` column, and
//! `analytics.rs` has always aggregated it into `averageSentiment` for the
//! "Avg Sentiment" stat card — but nothing ever *wrote* it, so every row was
//! NULL and the card rendered the `sentiment_count == 0` fallback. This module
//! is the missing scorer; `history::insert_entry` now calls [`score`] on write.
//!
//! # Provenance
//!
//! Ported from the sibling project this dictation feature came from:
//! `D:\projects\vibe2text` — `src-tauri/src/sentiment.rs` (+ its vendored
//! `src-tauri/src/vader_lexicon.txt`, copied here byte-identical). That file is
//! itself a faithful Rust port of the `vaderSentiment` Python library
//! (Hutto & Gilbert, ICWSM-14). The port is deliberately *literal*: rule order,
//! constants and edge cases mirror upstream so that a score computed here can be
//! diffed against `SentimentIntensityAnalyzer().polarity_scores(t)["compound"]`.
//! Do not "improve" the heuristics — matching upstream is the whole point.
//!
//! # Third-party licence (VADER lexicon + algorithm)
//!
//! `vader_lexicon.txt` and the rule set below derive from
//! <https://github.com/cjhutto/vaderSentiment>, which is MIT licensed. The
//! notice is reproduced here as MIT requires:
//!
//! > The MIT License (MIT)
//! >
//! > Copyright (c) 2016 C.J. Hutto
//! >
//! > Permission is hereby granted, free of charge, to any person obtaining a
//! > copy of this software and associated documentation files (the "Software"),
//! > to deal in the Software without restriction, including without limitation
//! > the rights to use, copy, modify, merge, publish, distribute, sublicense,
//! > and/or sell copies of the Software, and to permit persons to whom the
//! > Software is furnished to do so, subject to the following conditions:
//! >
//! > The above copyright notice and this permission notice shall be included in
//! > all copies or substantial portions of the Software.
//! >
//! > THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//! > IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//! > FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//! > AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//! > LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
//! > FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
//! > DEALINGS IN THE SOFTWARE.
//!
//! Academic citation requested by the authors: Hutto, C.J. & Gilbert, E.E.
//! (2014). *VADER: A Parsimonious Rule-based Model for Sentiment Analysis of
//! Social Media Text.* Eighth International Conference on Weblogs and Social
//! Media (ICWSM-14).
//!
//! `vader_lexicon.txt` is the official, complete upstream file (7520 tokens,
//! CRLF, `token\tmean\tstd\t[raw ratings]`) copied verbatim — deliberately
//! **not** annotated with a header, so re-vendoring stays a straight `cp` and
//! `sha256` proves it untouched:
//! `19b824842e261209723ded0c241d5a1e7da43e605330603dcbda2e4af6e527d6`.
//! Only the first two TAB fields (token, mean valence) are read, matching
//! upstream `make_lex_dict()`.
//!
//! # Scope
//!
//! - Only the **compound** score is produced — `entries.sentiment` is a single
//!   REAL, and the frontend (`DictationView.tsx`) plots it on a fixed
//!   -1.0 .. +1.0 axis. pos/neg/neu ratios are not exposed.
//! - Emoji-to-text expansion (upstream `emoji_utf8_lexicon.txt`) is **not**
//!   ported: Whisper transcripts of speech do not contain literal emoji, and
//!   that step only rewrites text *before* an otherwise identical scoring path.
//! - Every rule heuristic *is* ported: booster/dampener intensifiers, negation
//!   flip within a 3-token window (distance dampening 0.95 / 0.90), ALL-CAPS
//!   emphasis, exclamation/question amplification, the "but" contrastive
//!   reweighting (0.5 before / 1.5 after), special-case idioms, "least"
//!   negation, "no" negation, and normalization with alpha = 15.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

// Empirically derived constants (verbatim from vaderSentiment.py).
const B_INCR: f64 = 0.293; // booster/intensifier increment
const B_DECR: f64 = -0.293; // dampener decrement
const C_INCR: f64 = 0.733; // ALL-CAPS emphasis increment
const N_SCALAR: f64 = -0.74; // negation multiplier
const ALPHA: f64 = 15.0; // normalization constant
const EXCL_AMP: f64 = 0.292; // per-"!" amplifier (max 4)

/// The complete official VADER lexicon, vendored alongside this source.
/// Format per line: `token\tmean\tstd\t[raw ratings]`. We keep token + mean.
const VADER_LEXICON: &str = include_str!("vader_lexicon.txt");

/// Negation words. Mirrors upstream `NEGATE`.
const NEGATE: &[&str] = &[
    "aint",
    "arent",
    "cannot",
    "cant",
    "couldnt",
    "darent",
    "didnt",
    "doesnt",
    "ain't",
    "aren't",
    "can't",
    "couldn't",
    "daren't",
    "didn't",
    "doesn't",
    "dont",
    "hadnt",
    "hasnt",
    "havent",
    "isnt",
    "mightnt",
    "mustnt",
    "neither",
    "don't",
    "hadn't",
    "hasn't",
    "haven't",
    "isn't",
    "mightn't",
    "mustn't",
    "neednt",
    "needn't",
    "never",
    "none",
    "nope",
    "nor",
    "not",
    "nothing",
    "nowhere",
    "oughtnt",
    "shant",
    "shouldnt",
    "uhuh",
    "wasnt",
    "werent",
    "oughtn't",
    "shan't",
    "shouldn't",
    "uh-uh",
    "wasn't",
    "weren't",
    "without",
    "wont",
    "wouldnt",
    "won't",
    "wouldn't",
    "rarely",
    "seldom",
    "despite",
];

/// Booster / dampener intensifiers. Mirrors upstream `BOOSTER_DICT`.
/// Includes the multi-word entries (looked up as bigrams/trigrams in the idiom
/// check, which is why "just enough" / "sort of" sit in the same table).
const BOOSTER: &[(&str, f64)] = &[
    ("absolutely", B_INCR),
    ("amazingly", B_INCR),
    ("awfully", B_INCR),
    ("completely", B_INCR),
    ("considerable", B_INCR),
    ("considerably", B_INCR),
    ("decidedly", B_INCR),
    ("deeply", B_INCR),
    ("effing", B_INCR),
    ("enormous", B_INCR),
    ("enormously", B_INCR),
    ("entirely", B_INCR),
    ("especially", B_INCR),
    ("exceptional", B_INCR),
    ("exceptionally", B_INCR),
    ("extreme", B_INCR),
    ("extremely", B_INCR),
    ("fabulously", B_INCR),
    ("flipping", B_INCR),
    ("flippin", B_INCR),
    ("frackin", B_INCR),
    ("fracking", B_INCR),
    ("fricking", B_INCR),
    ("frickin", B_INCR),
    ("frigging", B_INCR),
    ("friggin", B_INCR),
    ("fully", B_INCR),
    ("fuckin", B_INCR),
    ("fucking", B_INCR),
    ("fuggin", B_INCR),
    ("fugging", B_INCR),
    ("greatly", B_INCR),
    ("hella", B_INCR),
    ("highly", B_INCR),
    ("hugely", B_INCR),
    ("incredible", B_INCR),
    ("incredibly", B_INCR),
    ("intensely", B_INCR),
    ("major", B_INCR),
    ("majorly", B_INCR),
    ("more", B_INCR),
    ("most", B_INCR),
    ("particularly", B_INCR),
    ("purely", B_INCR),
    ("quite", B_INCR),
    ("really", B_INCR),
    ("remarkably", B_INCR),
    ("so", B_INCR),
    ("substantially", B_INCR),
    ("thoroughly", B_INCR),
    ("total", B_INCR),
    ("totally", B_INCR),
    ("tremendous", B_INCR),
    ("tremendously", B_INCR),
    ("uber", B_INCR),
    ("unbelievably", B_INCR),
    ("unusually", B_INCR),
    ("utter", B_INCR),
    ("utterly", B_INCR),
    ("very", B_INCR),
    ("almost", B_DECR),
    ("barely", B_DECR),
    ("hardly", B_DECR),
    ("just enough", B_DECR),
    ("kind of", B_DECR),
    ("kinda", B_DECR),
    ("kindof", B_DECR),
    ("kind-of", B_DECR),
    ("less", B_DECR),
    ("little", B_DECR),
    ("marginal", B_DECR),
    ("marginally", B_DECR),
    ("occasional", B_DECR),
    ("occasionally", B_DECR),
    ("partly", B_DECR),
    ("scarce", B_DECR),
    ("scarcely", B_DECR),
    ("slight", B_DECR),
    ("slightly", B_DECR),
    ("somewhat", B_DECR),
    ("sort of", B_DECR),
    ("sorta", B_DECR),
    ("sortof", B_DECR),
    ("sort-of", B_DECR),
];

/// Special-case idioms containing lexicon words. Mirrors upstream
/// `SPECIAL_CASES`. These *replace* the accumulated valence rather than adding
/// to it, which is why "the shit" reads positive.
const SPECIAL_CASES: &[(&str, f64)] = &[
    ("the shit", 3.0),
    ("the bomb", 3.0),
    ("bad ass", 1.5),
    ("badass", 1.5),
    ("bus stop", 0.0),
    ("yeah right", -2.0),
    ("kiss of death", -1.5),
    ("to die for", 3.0),
    ("beating heart", 3.1),
    ("broken heart", -2.9),
];

struct Resources {
    lexicon: HashMap<String, f64>,
    negate: HashSet<&'static str>,
    booster: HashMap<&'static str, f64>,
    special: HashMap<&'static str, f64>,
}

/// Parse the vendored lexicon exactly once.
///
/// `insert_entry` runs on every finished transcription, and the tables are
/// ~7.5k immutable entries — building them per call would re-parse 424 KB of
/// text on the transcription hot path.
fn resources() -> &'static Resources {
    static RES: OnceLock<Resources> = OnceLock::new();
    RES.get_or_init(|| {
        let mut lexicon = HashMap::new();
        // The upstream file is CRLF; split on '\n' and trim the '\r' so the
        // token/valence pair does not pick up a stray carriage return.
        for line in VADER_LEXICON.trim_end_matches('\n').split('\n') {
            let line = line.trim_end_matches('\r');
            if line.is_empty() {
                continue;
            }
            let mut parts = line.split('\t');
            if let (Some(word), Some(measure)) = (parts.next(), parts.next()) {
                if let Ok(value) = measure.trim().parse::<f64>() {
                    lexicon.insert(word.to_string(), value);
                }
            }
        }
        Resources {
            lexicon,
            negate: NEGATE.iter().copied().collect(),
            booster: BOOSTER.iter().copied().collect(),
            special: SPECIAL_CASES.iter().copied().collect(),
        }
    })
}

/// Compute the VADER **compound** score for `text`, in the range -1.0 ..= 1.0
/// (0.0 for empty/neutral input). Equivalent to
/// `SentimentIntensityAnalyzer().polarity_scores(text)["compound"]`.
///
/// This is the value written to `entries.sentiment` and averaged by
/// `analytics::average_sentiment`.
pub fn score(text: &str) -> f64 {
    let res = resources();
    let tokens = words_and_emoticons(text);
    let is_cap_diff = allcap_differential(&tokens);

    let mut sentiments: Vec<f64> = Vec::with_capacity(tokens.len());
    for i in 0..tokens.len() {
        let item = &tokens[i];
        let item_lower = item.to_lowercase();

        // Booster words and the "kind of" bigram contribute zero valence
        // themselves — they only modify a neighbouring lexicon word.
        if res.booster.contains_key(item_lower.as_str()) {
            sentiments.push(0.0);
            continue;
        }
        if i < tokens.len() - 1 && item_lower == "kind" && tokens[i + 1].to_lowercase() == "of" {
            sentiments.push(0.0);
            continue;
        }

        let v = sentiment_valence(res, &tokens, item, &item_lower, i, is_cap_diff);
        sentiments.push(v);
    }

    but_check(&tokens, &mut sentiments);
    score_valence(&sentiments, text)
}

/// Tokenize: split on whitespace and strip leading/trailing ASCII punctuation,
/// but keep tokens whose stripped form is <= 2 chars (likely emoticons) and
/// preserve contractions. Mirrors `SentiText._words_and_emoticons`.
fn words_and_emoticons(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|tok| {
            let stripped = tok.trim_matches(|c: char| c.is_ascii_punctuation());
            if stripped.chars().count() <= 2 {
                tok.to_string()
            } else {
                stripped.to_string()
            }
        })
        .collect()
}

/// True if some (but not all) tokens are ALL CAPS. Mirrors
/// `allcap_differential` — shouting only counts as emphasis when the rest of
/// the sentence is not also shouting.
fn allcap_differential(words: &[String]) -> bool {
    let allcap = words.iter().filter(|w| is_upper(w)).count();
    let diff = words.len() as isize - allcap as isize;
    diff > 0 && (diff as usize) < words.len()
}

/// Python `str.isupper()`: at least one cased char, and all cased chars
/// uppercase. Rust's `str::to_uppercase() == s` would call "!!!" uppercase.
fn is_upper(s: &str) -> bool {
    let mut has_cased = false;
    for c in s.chars() {
        if c.is_lowercase() {
            return false;
        }
        if c.is_uppercase() {
            has_cased = true;
        }
    }
    has_cased
}

/// `negated()` for a single token — true if it is a negation word or contains
/// "n't".
fn negated(word_lower: &str, negate: &HashSet<&'static str>) -> bool {
    negate.contains(word_lower) || word_lower.contains("n't")
}

/// `scalar_inc_dec`: booster contribution of a preceding word given the target
/// word's valence. A booster in front of a negative word pushes *further*
/// negative, hence the sign flip.
fn scalar_inc_dec(
    word: &str,
    valence: f64,
    is_cap_diff: bool,
    booster: &HashMap<&str, f64>,
) -> f64 {
    let word_lower = word.to_lowercase();
    let mut scalar = match booster.get(word_lower.as_str()) {
        Some(&s) => s,
        None => return 0.0,
    };
    if valence < 0.0 {
        scalar *= -1.0;
    }
    if is_upper(word) && is_cap_diff {
        if valence > 0.0 {
            scalar += C_INCR;
        } else {
            scalar -= C_INCR;
        }
    }
    scalar
}

fn sentiment_valence(
    res: &Resources,
    words: &[String],
    item: &str,
    item_lower: &str,
    i: usize,
    is_cap_diff: bool,
) -> f64 {
    let base = match res.lexicon.get(item_lower) {
        Some(&v) => v,
        None => return 0.0,
    };
    let mut valence = base;

    // "no" as negation of an adjacent lexicon item vs standalone lexicon item.
    if item_lower == "no"
        && i != words.len() - 1
        && res
            .lexicon
            .contains_key(words[i + 1].to_lowercase().as_str())
    {
        valence = 0.0;
    }
    if (i > 0 && words[i - 1].to_lowercase() == "no")
        || (i > 1 && words[i - 2].to_lowercase() == "no")
        || (i > 2
            && words[i - 3].to_lowercase() == "no"
            && matches!(words[i - 1].to_lowercase().as_str(), "or" | "nor"))
    {
        valence = base * N_SCALAR;
    }

    // ALL-CAPS emphasis for the sentiment-laden word itself.
    if is_upper(item) && is_cap_diff {
        if valence > 0.0 {
            valence += C_INCR;
        } else {
            valence -= C_INCR;
        }
    }

    // Apply preceding modifiers within a 3-token window with distance dampening
    // (the further away the booster, the less it counts).
    for start_i in 0..3usize {
        if i > start_i {
            let prev = &words[i - (start_i + 1)];
            if !res.lexicon.contains_key(prev.to_lowercase().as_str()) {
                let mut s = scalar_inc_dec(prev, valence, is_cap_diff, &res.booster);
                if start_i == 1 && s != 0.0 {
                    s *= 0.95;
                }
                if start_i == 2 && s != 0.0 {
                    s *= 0.9;
                }
                valence += s;
                valence = negation_check(valence, words, start_i, i, &res.negate);
                if start_i == 2 {
                    valence = special_idioms_check(valence, words, i, &res.booster, &res.special);
                }
            }
        }
    }

    least_check(valence, words, i, &res.lexicon)
}

fn least_check(valence: f64, words: &[String], i: usize, lexicon: &HashMap<String, f64>) -> f64 {
    if i > 1
        && !lexicon.contains_key(words[i - 1].to_lowercase().as_str())
        && words[i - 1].to_lowercase() == "least"
    {
        let prev2 = words[i - 2].to_lowercase();
        // "at least" / "very least" are concessive, not negating.
        if prev2 != "at" && prev2 != "very" {
            return valence * N_SCALAR;
        }
    } else if i > 0
        && !lexicon.contains_key(words[i - 1].to_lowercase().as_str())
        && words[i - 1].to_lowercase() == "least"
    {
        return valence * N_SCALAR;
    }
    valence
}

/// `_but_check`: contrastive conjunction reweighting (0.5 before / 1.5 after
/// "but"), so the clause after the "but" dominates the sentence.
fn but_check(words: &[String], sentiments: &mut [f64]) {
    let lower: Vec<String> = words.iter().map(|w| w.to_lowercase()).collect();
    if let Some(bi) = lower.iter().position(|w| w == "but") {
        for (si, s) in sentiments.iter_mut().enumerate() {
            if si < bi {
                *s *= 0.5;
            } else if si > bi {
                *s *= 1.5;
            }
        }
    }
}

fn special_idioms_check(
    mut valence: f64,
    words: &[String],
    i: usize,
    booster: &HashMap<&str, f64>,
    special: &HashMap<&str, f64>,
) -> f64 {
    let lower: Vec<String> = words.iter().map(|w| w.to_lowercase()).collect();
    let at = |idx: usize| lower[idx].as_str();

    // i >= 3 is guaranteed by the caller (start_i == 2 implies i > 2).
    let onezero = format!("{} {}", at(i - 1), at(i));
    let twoonezero = format!("{} {} {}", at(i - 2), at(i - 1), at(i));
    let twoone = format!("{} {}", at(i - 2), at(i - 1));
    let threetwoone = format!("{} {} {}", at(i - 3), at(i - 2), at(i - 1));
    let threetwo = format!("{} {}", at(i - 3), at(i - 2));

    for seq in [&onezero, &twoonezero, &twoone, &threetwoone, &threetwo] {
        if let Some(&v) = special.get(seq.as_str()) {
            valence = v;
            break;
        }
    }

    if lower.len() - 1 > i {
        let zeroone = format!("{} {}", at(i), at(i + 1));
        if let Some(&v) = special.get(zeroone.as_str()) {
            valence = v;
        }
    }
    if lower.len() > i + 2 {
        let zeroonetwo = format!("{} {} {}", at(i), at(i + 1), at(i + 2));
        if let Some(&v) = special.get(zeroonetwo.as_str()) {
            valence = v;
        }
    }

    // Booster/dampener bigrams & trigrams (e.g. "sort of", "kind of").
    for n_gram in [&threetwoone, &threetwo, &twoone] {
        if let Some(&b) = booster.get(n_gram.as_str()) {
            valence += b;
        }
    }
    valence
}

fn negation_check(
    mut valence: f64,
    words: &[String],
    start_i: usize,
    i: usize,
    negate: &HashSet<&'static str>,
) -> f64 {
    let lower = |idx: usize| words[idx].to_lowercase();
    match start_i {
        0 => {
            if negated(&lower(i - 1), negate) {
                valence *= N_SCALAR;
            }
        }
        1 => {
            let w2 = lower(i - 2);
            let w1 = lower(i - 1);
            if w2 == "never" && (w1 == "so" || w1 == "this") {
                valence *= 1.25;
            } else if w2 == "without" && w1 == "doubt" {
                // "without doubt" is emphatic, not negating — leave unchanged.
            } else if negated(&lower(i - 2), negate) {
                valence *= N_SCALAR;
            }
        }
        2 => {
            let w3 = lower(i - 3);
            let w2 = lower(i - 2);
            let w1 = lower(i - 1);
            // Mirrors upstream precedence: (w3=="never" && w2 so/this) || (w1 so/this)
            if (w3 == "never" && (w2 == "so" || w2 == "this")) || (w1 == "so" || w1 == "this") {
                valence *= 1.25;
            } else if w3 == "without" && (w2 == "doubt" || w1 == "doubt") {
                // unchanged
            } else if negated(&lower(i - 3), negate) {
                valence *= N_SCALAR;
            }
        }
        _ => {}
    }
    valence
}

/// Exclamation-point amplifier (up to 4 marks).
fn amplify_ep(text: &str) -> f64 {
    let count = text.matches('!').count().min(4) as f64;
    count * EXCL_AMP
}

/// Question-mark amplifier (2-3 marks scaled, 4+ capped at 0.96).
fn amplify_qm(text: &str) -> f64 {
    let count = text.matches('?').count();
    if count > 1 {
        if count <= 3 {
            count as f64 * 0.18
        } else {
            0.96
        }
    } else {
        0.0
    }
}

/// `normalize`: squash summed valence into [-1, 1] using alpha = 15.
fn normalize(score: f64) -> f64 {
    let norm = score / (score * score + ALPHA).sqrt();
    norm.clamp(-1.0, 1.0)
}

/// `score_valence`: combine per-token valences + punctuation emphasis into the
/// final compound score, rounded to 4 decimals (matching the Python output).
fn score_valence(sentiments: &[f64], text: &str) -> f64 {
    if sentiments.is_empty() {
        return 0.0;
    }
    let mut sum_s: f64 = sentiments.iter().sum();
    let punct = amplify_ep(text) + amplify_qm(text);
    if sum_s > 0.0 {
        sum_s += punct;
    } else if sum_s < 0.0 {
        sum_s -= punct;
    }
    let compound = normalize(sum_s);
    // Round to 4 decimal places, matching the reference writer's output so
    // scores are directly comparable with the Python implementation.
    (compound * 10_000.0).round() / 10_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f64, b: f64, eps: f64) -> bool {
        (a - b).abs() <= eps
    }

    #[test]
    fn lexicon_loaded() {
        // Sanity: the full official lexicon should have thousands of entries.
        assert!(
            resources().lexicon.len() > 7000,
            "lexicon too small: {} entries (is the full vader_lexicon.txt vendored?)",
            resources().lexicon.len()
        );
        assert!(resources().lexicon.contains_key("smart"));
        assert!(resources().lexicon.contains_key("horrible"));
    }

    #[test]
    fn strongly_positive() {
        // Canonical VADER example. Python reports compound ~0.8439.
        let s = score("VADER is smart, handsome, and funny!");
        assert!(s > 0.7, "expected strongly positive, got {s}");
        assert!(approx(s, 0.8439, 0.01), "expected ~0.8439, got {s}");
    }

    #[test]
    fn punctuation_amplifies() {
        let plain = score("VADER is smart, handsome, and funny.");
        let bang = score("VADER is smart, handsome, and funny!");
        let triple = score("VADER is smart, handsome, and funny!!!");
        assert!(bang > plain, "exclamation should raise score");
        assert!(
            triple > bang,
            "more exclamations should raise score further"
        );
    }

    #[test]
    fn allcaps_amplifies() {
        let normal = score("VADER is very smart, handsome, and funny.");
        let caps = score("VADER is VERY SMART, handsome, and FUNNY.");
        assert!(caps > normal, "ALLCAPS should amplify: {caps} vs {normal}");
    }

    #[test]
    fn negation_flips() {
        let pos = score("VADER is smart, handsome, and funny.");
        let neg = score("VADER is not smart, handsome, nor funny.");
        assert!(pos > 0.0, "baseline should be positive");
        assert!(neg < 0.0, "negation should flip to negative, got {neg}");
    }

    /// The task's minimum bar, stated the plain way: "not good" must land on the
    /// opposite side of zero from "good".
    #[test]
    fn not_good_is_negative() {
        let good = score("good");
        let not_good = score("not good");
        assert!(good > 0.0, "\"good\" should be positive, got {good}");
        assert!(
            not_good < 0.0,
            "\"not good\" should flip negative, got {not_good}"
        );
        // Upstream: 0.4404 * -0.74 -> normalize == -0.3412.
        assert!(
            approx(not_good, -0.3412, 0.001),
            "expected ~-0.3412, got {not_good}"
        );
    }

    #[test]
    fn simple_negative() {
        let s = score("This is horrible");
        assert!(s < -0.4, "expected clearly negative, got {s}");
    }

    #[test]
    fn neutral_is_near_zero() {
        let s = score("The book is on the table.");
        assert!(s.abs() < 0.1, "expected near-zero neutral, got {s}");
    }

    #[test]
    fn empty_and_whitespace() {
        assert_eq!(score(""), 0.0);
        assert_eq!(score("   "), 0.0);
    }

    /// A transcript with no lexicon hits at all must score exactly neutral, not
    /// drift — most dictation is technical prose like this.
    ///
    /// Every token below was checked against the vendored lexicon; note how
    /// easily ordinary technical prose *does* hit it ("resolves" is +0.7, which
    /// alone scores 0.1779), so keep this sentence deliberately bland.
    #[test]
    fn text_without_lexicon_hits_is_exactly_zero() {
        assert_eq!(
            score("the pointer at index four returns to the caller"),
            0.0
        );
        assert_eq!(score("cargo build then cargo test"), 0.0);
        assert_eq!(score("move the cursor into the next buffer"), 0.0);
    }

    #[test]
    fn booster_increases_magnitude() {
        let plain = score("The book was good.");
        let boosted = score("The book was very good.");
        assert!(
            boosted > plain,
            "booster should increase: {boosted} vs {plain}"
        );
        // Dampeners move the other way.
        let damped = score("The book was slightly good.");
        assert!(
            damped < plain,
            "dampener should decrease: {damped} vs {plain}"
        );
    }

    #[test]
    fn but_clause_shifts_dominance() {
        // Later clause dominates: net should lean negative.
        let s = score(
            "The plot was good, but the characters are uncompelling and the dialog is not great.",
        );
        assert!(s < 0.0, "but-clause should make this net negative, got {s}");
    }

    #[test]
    fn least_negation() {
        // "at least" should NOT negate; bare "least" would.
        let s = score("At least it isn't a horrible book.");
        assert!(s > 0.0, "negated negative should read positive, got {s}");
    }

    #[test]
    fn range_is_bounded() {
        let extreme =
            score("This is the best most amazing wonderful fantastic perfect thing EVER!!!!");
        assert!((-1.0..=1.0).contains(&extreme));
        assert!(extreme > 0.5);
    }

    /// `DictationView.tsx` plots `sentiment` on a fixed -1..+1 axis and buckets
    /// it at +/-0.1 and +/-0.3. Nothing this scorer emits may leave that band.
    #[test]
    fn output_stays_inside_the_range_the_frontend_assumes() {
        for text in [
            "",
            "neutral filler text",
            "GREAT GREAT GREAT AMAZING PERFECT LOVE LOVE!!!!!!!",
            "awful terrible horrible disgusting hate hate hate!!!!!!!",
            "not not not not good good good",
        ] {
            let s = score(text);
            assert!(
                (-1.0..=1.0).contains(&s),
                "score {s} out of range for {text:?}"
            );
        }
    }
}
