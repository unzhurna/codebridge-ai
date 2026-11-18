import { describe, expect, it } from "vitest";

describe("VS Code extension foundation", () => {
  it("has a valid baseline test environment", () => {
    expect("codebridge").toContain("bridge");
  });
});
