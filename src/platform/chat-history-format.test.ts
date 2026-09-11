import { describe, expect, it } from "vitest";
import {
  deriveTitleFromFirstMessage,
  formatHistoryTime,
} from "./chat-history-format";

describe("chat history display formatting", () => {
  it("uses short first messages as final conversation titles", () => {
    expect(deriveTitleFromFirstMessage("整理一下")).toEqual({
      title: "整理一下",
      titleState: "final",
    });
  });

  it("uses the first ten characters of a long first message as a temporary title", () => {
    expect(deriveTitleFromFirstMessage("请帮我把今天会议纪要整理成行动项")).toEqual({
      title: "请帮我把今天会议纪要",
      titleState: "temporary",
    });
  });

  it("formats history times by recency", () => {
    const now = new Date(2026, 6, 8, 15, 40).getTime();

    expect(formatHistoryTime(new Date(2026, 6, 8, 9, 5).getTime(), now)).toBe("09:05");
    expect(formatHistoryTime(new Date(2026, 6, 7, 22).getTime(), now)).toBe("昨天");
    expect(formatHistoryTime(new Date(2026, 6, 5, 12).getTime(), now)).toBe("07/05");
    expect(formatHistoryTime(new Date(2025, 11, 31, 12).getTime(), now)).toBe("2025/12/31");
  });
});
