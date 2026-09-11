// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildActionCard, updateActionCard } from "./action-card";
import type { ActionBlock } from "./render/state";

describe("action cards", () => {
  it("renders distinct semantic icons from the agent category", () => {
    const categories = [
      "skill",
      "document_read",
      "document_list",
      "document_find",
      "document_search",
      "web_search",
      "web_fetch",
      "document_write",
      "document_create",
      "tag",
      "other",
    ] as const;
    const icons = categories.map((category, index) => {
      const card = buildActionCard({
        id: `tool-${index}`,
        kind: "action",
        tool: category === "other" ? "custom_tool" : category,
        category,
        label: `工具 ${category}`,
        targets: [],
        decision: "pending",
        execution: "running",
      });
      const icon = card.querySelector<HTMLElement>(".chat-action-icon");
      expect(icon?.dataset.toolCategory).toBe(category);
      return icon?.innerHTML;
    });

    expect(new Set(icons).size).toBe(categories.length);
  });

  it("updates a prepared read row to the Skill icon when execution reveals its category", () => {
    const prepared: ActionBlock = {
      id: "tool-skill",
      kind: "action",
      tool: "read",
      label: "正在准备工具调用…",
      targets: [],
      decision: "pending",
      execution: "running",
    };
    const card = buildActionCard(prepared);

    updateActionCard(card, { ...prepared, category: "skill", label: "读取技能 brainstorming" });

    const icon = card.querySelector<HTMLElement>(".chat-action-icon");
    expect(icon?.dataset.toolCategory).toBe("skill");
    expect(card.querySelector(".chat-action-title")?.textContent).toBe("读取技能 brainstorming");
  });

  it("marks a rejected tool with its independent visual state", () => {
    const block: ActionBlock = {
      id: "tool-1",
      kind: "action",
      tool: "write",
      targets: [],
      decision: "pending",
      execution: "rejected",
    };

    const card = buildActionCard(block);

    expect(card.classList.contains("chat-action-rejected")).toBe(true);
    expect(card.textContent).toContain("已拒绝");
  });

  it("gives rejected compact tool titles a stronger warning selector", () => {
    const css = readFileSync(resolve(process.cwd(), "src/assistant/styles.css"), "utf8");

    expect(css).toContain(".chat-action.chat-action-readonly.chat-action-rejected .chat-action-header");
  });
});
