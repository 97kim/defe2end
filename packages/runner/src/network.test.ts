import { describe, expect, it } from "vitest";
import { hostResolverRules, isBlockedUrl } from "./network.js";

const open = { blockPrivateNetworks: false };
const closed = { blockPrivateNetworks: true };

describe("isBlockedUrl", () => {
  it("blocks cloud metadata addresses in every spelling", () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://2852039166/",
      "http://0xa9fea9fe/",
      "http://0251.0376.0251.0376/",
      "http://169.254.43518/",
      "http://[::ffff:169.254.169.254]/",
      "http://[::ffff:a9fe:a9fe]/",
      "http://[fd00:ec2::254]/",
      "http://[fd00:ec2:0:0:0:0:0:254]/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://METADATA.google.internal./",
      "http://169.254.170.2/v2/credentials",
    ]) {
      expect(isBlockedUrl(url, open), url).toBe(true);
    }
  });

  it("allows ordinary and local targets unless private ranges are switched on", () => {
    for (const url of ["https://example.com/", "http://127.0.0.1:3000/", "http://10.0.0.5/", "http://[::1]/", "http://localhost/"]) {
      expect(isBlockedUrl(url, open), url).toBe(false);
    }
    for (const url of ["http://127.0.0.1:3000/", "http://10.0.0.5/", "http://192.168.1.1/", "http://[::1]/", "http://localhost/", "http://[fd12::1]/", "http://2130706433/"]) {
      expect(isBlockedUrl(url, closed), url).toBe(true);
    }
    expect(isBlockedUrl("https://example.com/", closed)).toBe(false);
  });

  it("refuses local schemes", () => {
    expect(isBlockedUrl("file:///etc/passwd", open)).toBe(true);
    expect(isBlockedUrl("chrome://settings", open)).toBe(true);
    expect(isBlockedUrl("not a url", open)).toBe(true);
  });

  it("normalizes private addresses in every spelling and covers WebSockets", () => {
    for (const url of ["http://0x7f000001/", "http://0177.0.0.1/", "http://127.1/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:a00:1]/", "http://167772161/", "ws://10.0.0.1/", "wss://[::1]/"]) {
      expect(isBlockedUrl(url, closed), url).toBe(true);
      expect(isBlockedUrl(url, open), url).toBe(false);
    }
    expect(isBlockedUrl("ws://169.254.169.254/", open)).toBe(true);
    expect(isBlockedUrl("wss://example.com/socket", closed)).toBe(false);
  });

  it("refuses data, blob and javascript URLs", () => {
    for (const url of ["data:text/html,hi", "blob:https://example.com/x", "javascript:alert(1)", "ftp://example.com/"]) expect(isBlockedUrl(url, open), url).toBe(true);
  });
});

describe("hostResolverRules", () => {
  it("always refuses metadata hosts and adds private ranges only when asked", () => {
    expect(hostResolverRules(open)).toContain("MAP 169.254.* ~NOTFOUND");
    expect(hostResolverRules(open)).not.toContain("MAP 127.* ~NOTFOUND");
    const rules = hostResolverRules(closed);
    for (const pattern of ["127.*", "10.*", "192.168.*", "172.16.*", "172.31.*", "100.64.*", "100.127.*", "localhost", "::1", "fd*:*", "::ffff:7f??:*"]) {
      expect(rules, pattern).toContain(`MAP ${pattern} ~NOTFOUND`);
    }
    expect(rules).not.toContain("MAP 172.32.* ~NOTFOUND");
  });

  it("refuses every blocked name with a trailing dot too, as isBlockedUrl does", () => {
    const rules = hostResolverRules(closed);
    for (const pattern of ["localhost.", "*.localhost.", "metadata.google.internal.", "metadata.goog.", "metadata.azure.internal.", "100.100.100.200."]) {
      expect(rules, pattern).toContain(`MAP ${pattern} ~NOTFOUND`);
    }
    expect(hostResolverRules(open)).toContain("MAP metadata.google.internal. ~NOTFOUND");
    expect(hostResolverRules(open)).not.toContain("MAP localhost. ~NOTFOUND");
    for (const url of ["http://localhost./", "http://a.localhost./", "http://metadata.google.internal./"]) expect(isBlockedUrl(url, closed), url).toBe(true);
  });

  it("puts aliases ahead of the blocking rules", () => {
    expect(hostResolverRules(closed, { "fixture.test": "127.0.0.1" }).startsWith("MAP fixture.test 127.0.0.1, ")).toBe(true);
  });
});
