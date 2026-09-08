import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeInbox, encodeInbox } from "./index";

interface Fixture {
  name: string;
  raw: string;
  markdown: string;
  tags: Array<{ id: string; name: string; color: string }>;
  annotations: Array<{ id: string; tagId: string; from: number; to: number }>;
  quoteSources: Array<{ cardFrom: number; bundleId: string }>;
}

const fixtures = JSON.parse(readFileSync(new URL("../fixtures/agent-parity.json", import.meta.url), "utf8")) as Fixture[];

describe("Rust Agent codec parity fixtures", () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const decoded = decodeInbox(fixture.raw);
      expect(decoded.markdown).toBe(fixture.markdown);
      expect(decoded.metadata).toEqual({ tags: fixture.tags, annotations: fixture.annotations, quoteSources: fixture.quoteSources });
      expect(decodeInbox(encodeInbox(decoded.markdown, decoded.metadata)).metadata).toEqual(decoded.metadata);
    });
  }
});
