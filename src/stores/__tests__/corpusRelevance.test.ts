import { describe, expect, it } from "vitest";
import { corpusRelevanceScores, relevanceScores } from "@/stores/memoryStore";

describe("corpusRelevanceScores", () => {
  it("matches a prefix: 'auth' finds 'authentication'", () => {
    const [hit] = corpusRelevanceScores("auth", ["authentication uses the keyring"]);
    expect(hit.score).toBeGreaterThan(0);
    expect(hit.matched).toContain("auth");
  });

  it("matches the reverse prefix: 'authentication' finds 'auth'", () => {
    const [hit] = corpusRelevanceScores("authentication", ["auth is handled by the sidecar"]);
    expect(hit.score).toBeGreaterThan(0);
  });

  it("matches by stem: 'tokens' finds 'token'", () => {
    const [hit] = corpusRelevanceScores("tokens", ["token refresh flow"]);
    expect(hit.score).toBeGreaterThan(0);
  });

  it("falls back to a raw substring for compound identifiers", () => {
    const [hit] = corpusRelevanceScores("sshconfig", ["SshConfig carries host_fingerprint"]);
    expect(hit.score).toBeGreaterThan(0);
  });

  it("keeps two-character tokens the injection scorer drops", () => {
    const [hit] = corpusRelevanceScores("db", ["db migrations run on boot"]);
    expect(hit.score).toBeGreaterThan(0);
  });

  it("falls back to whole-phrase substring for a stopword-only query", () => {
    const scores = corpusRelevanceScores("the and to", ["the and to appears verbatim", "nope"]);
    expect(scores[0].score).toBe(1);
    expect(scores[1].score).toBe(0);
  });

  it("rewards a verbatim phrase over the same terms scattered", () => {
    const [phrase, scattered] = corpusRelevanceScores("ssh host fingerprint", [
      "always pin the ssh host fingerprint",
      "ssh matters, the host varies, fingerprint later",
    ]);
    expect(phrase.score).toBeGreaterThan(scattered.score);
  });

  it("scores full query coverage above partial coverage, within [0,1]", () => {
    const [full, partial] = corpusRelevanceScores("keyring fingerprint", [
      "keyring and fingerprint both handled",
      "keyring only",
    ]);
    expect(full.score).toBeGreaterThan(partial.score);
    for (const s of [full, partial]) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
    }
  });

  it("reports only the terms that actually hit", () => {
    const [hit] = corpusRelevanceScores("keyring zebra", ["keyring wrapper"]);
    expect(hit.matched).toContain("keyring");
    expect(hit.matched).not.toContain("zebra");
  });

  it("leaves the injection scorer narrow — the two must never be conflated", () => {
    // `relevanceScores` decides what goes into an agent's prompt. Widening Ask
    // must not widen injection, so this pins the old behaviour deliberately.
    expect(relevanceScores("auth", ["authentication uses JWT"])[0]).toBe(0);
  });
});
