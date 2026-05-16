import { describe, it, expect, beforeEach } from "vitest";
import {
  appendQualityHistory,
  clearQualityHistory,
  formatScoreDelta,
  loadQualityHistory,
  type CodeQualityHistoryEntry,
} from "../codeQualityHistory";
import type { CodeQualityReport } from "@/lib/tauri";

function fakeReport(): CodeQualityReport {
  return {
    total_files: 10,
    total_code_lines: 1000,
    total_lines: 1200,
    total_comment_lines: 100,
    total_blank_lines: 100,
    language_count: 2,
    languages: [],
    avg_complexity: 5,
    test_files: 2,
    test_lines: 200,
    top_complex_files: [],
    comment_ratio: 0.1,
    test_ratio: 0.2,
    org_score: 70,
  };
}

function entry(projectPath: string, totalScore: number, ranAt: number): CodeQualityHistoryEntry {
  return {
    projectPath,
    ranAt,
    totalScore,
    totalFiles: 10,
    totalCodeLines: 1000,
    testFiles: 2,
    report: fakeReport(),
  };
}

describe("codeQualityHistory", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns an empty list for unseen projects", () => {
    expect(loadQualityHistory("D:/code/foo")).toEqual([]);
  });

  it("appends newest-first and bounds the ring buffer at 5 entries", () => {
    const p = "D:/code/proj";
    for (let i = 0; i < 7; i++) {
      appendQualityHistory(entry(p, 50 + i, 1_000 + i));
    }
    const out = loadQualityHistory(p);
    expect(out.length).toBe(5);
    // Newest first
    expect(out[0].totalScore).toBe(56);
    expect(out[4].totalScore).toBe(52);
  });

  it("keys by normalised path so Windows backslashes match POSIX slashes", () => {
    appendQualityHistory(entry("D:\\code\\Proj", 80, 1));
    expect(loadQualityHistory("d:/code/proj").length).toBe(1);
  });

  it("isolates history per project", () => {
    appendQualityHistory(entry("D:/a", 70, 1));
    appendQualityHistory(entry("D:/b", 80, 2));
    expect(loadQualityHistory("D:/a")[0].totalScore).toBe(70);
    expect(loadQualityHistory("D:/b")[0].totalScore).toBe(80);
  });

  it("clears per-project history without touching others", () => {
    appendQualityHistory(entry("D:/a", 70, 1));
    appendQualityHistory(entry("D:/b", 80, 2));
    clearQualityHistory("D:/a");
    expect(loadQualityHistory("D:/a")).toEqual([]);
    expect(loadQualityHistory("D:/b").length).toBe(1);
  });

  it("recovers from corrupt localStorage entries", () => {
    window.localStorage.setItem("packetade:quality:history", "not json{");
    expect(loadQualityHistory("D:/x")).toEqual([]);
    // And we can still write afterwards.
    appendQualityHistory(entry("D:/x", 75, 10));
    expect(loadQualityHistory("D:/x").length).toBe(1);
  });

  it("formats positive deltas with a +, negative with -, equal with ±0", () => {
    expect(formatScoreDelta(80, 70).text).toBe("+10");
    expect(formatScoreDelta(60, 70).text).toBe("-10");
    expect(formatScoreDelta(70, 70).text).toBe("±0");
    expect(formatScoreDelta(70, undefined).text).toBe("—");
  });
});
