import { describe, expect, it } from "vitest";
import { bridgeEventSchema, createEvent, eventTypes } from "./index.js";

describe("bridge protocol", () => {
  it("creates a valid protocol envelope", () => {
    const event = createEvent("PING", "browser", { nonce: "abc" });
    expect(bridgeEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts an AI code proposal event", () => {
    const event = createEvent("AI_CODE_PROPOSAL", "browser", {
      code: "console.log('hello')",
      language: "javascript",
      source: "chatgpt"
    });
    expect(bridgeEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects unsupported protocol versions", () => {
    const event = createEvent("PING", "browser", {});
    expect(bridgeEventSchema.safeParse({
      ...event,
      protocolVersion: "99.0"
    }).success).toBe(false);
  });
});


describe("proposal protocol", () => {
  it("includes proposal result events", () => {
    expect(eventTypes).toContain("PROPOSAL_RESULT");
  });
});
