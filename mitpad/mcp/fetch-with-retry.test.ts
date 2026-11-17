import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module without types
import { MAX_RETRY_AFTER_MS, retryDelay } from "./fetch-with-retry.mjs";

const reply = (retryAfter?: string) => ({ headers: new Headers(retryAfter ? { "Retry-After": retryAfter } : {}) });

describe("retryDelay", () => {
  it("honours Retry-After up to the cap", () => {
    expect(retryDelay(reply("3"), 0)).toBe(3_000);
  });
  it("never waits longer than the cap", () => {
    expect(retryDelay(reply("120"), 0)).toBe(MAX_RETRY_AFTER_MS);
  });
  it("accepts a lower cap for callers with a tight deadline such as the health probe", () => {
    expect(retryDelay(reply("120"), 0, 1_000)).toBe(1_000);
  });
  it("falls back to a short linear backoff without the header", () => {
    expect(retryDelay(reply(), 1)).toBe(500);
  });
});
