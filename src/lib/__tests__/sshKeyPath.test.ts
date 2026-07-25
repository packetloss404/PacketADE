import { describe, it, expect } from "vitest";
import { isSafeKeyPath } from "@/lib/sshKeyPath";

describe("isSafeKeyPath", () => {
  it("accepts ordinary Unix key paths", () => {
    expect(isSafeKeyPath("~/.ssh/id_rsa")).toBe(true);
    expect(isSafeKeyPath("/home/jane/.ssh/id_ed25519")).toBe(true);
    expect(isSafeKeyPath("./keys/deploy_key")).toBe(true);
  });

  it("accepts Windows paths with backslashes, drive colons, and spaces", () => {
    expect(isSafeKeyPath("C:\\Users\\Jane Doe\\.ssh\\id_ed25519")).toBe(true);
    expect(isSafeKeyPath("C:\\Program Files (x86)\\keys\\id_rsa")).toBe(true);
  });

  it("treats an empty path as safe (means 'no key')", () => {
    expect(isSafeKeyPath("")).toBe(true);
  });

  it("rejects shell metacharacters", () => {
    expect(isSafeKeyPath("/tmp/key; rm -rf /")).toBe(false);
    expect(isSafeKeyPath("/tmp/key|cat")).toBe(false);
    expect(isSafeKeyPath("/tmp/key && whoami")).toBe(false);
    expect(isSafeKeyPath("/tmp/$(whoami)/key")).toBe(false);
    expect(isSafeKeyPath("/tmp/`id`/key")).toBe(false);
    expect(isSafeKeyPath("/tmp/key > /etc/passwd")).toBe(false);
    expect(isSafeKeyPath("/tmp/key < in")).toBe(false);
    expect(isSafeKeyPath("/tmp/'key'")).toBe(false);
    expect(isSafeKeyPath('/tmp/"key"')).toBe(false);
  });

  it("rejects control and non-printable bytes", () => {
    expect(isSafeKeyPath("/tmp/key\n")).toBe(false);
    expect(isSafeKeyPath("/tmp/\tkey")).toBe(false);
    expect(isSafeKeyPath("/tmp/key\r\nid")).toBe(false);
    expect(isSafeKeyPath("/tmp/key\u0000")).toBe(false);
    expect(isSafeKeyPath("/tmp/key\u007f")).toBe(false);
  });
});
