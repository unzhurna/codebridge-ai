import { describe, expect, it } from "vitest";

describe("CodeBridge popup foundation", () => {
  it("accepts six-digit pairing codes", () => {
    expect(/^\d{6}$/.test("123456")).toBe(true);
    expect(/^\d{6}$/.test("12345x")).toBe(false);
  });
});
