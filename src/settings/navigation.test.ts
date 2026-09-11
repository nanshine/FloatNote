import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { connectSettingsNavigation } from "./navigation";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

describe("settings navigation", () => {
  it("consumes a startup target after subscribing and handles later requests", async () => {
    let wake!: () => void;
    vi.mocked(listen).mockImplementation(async (_name, callback) => {
      wake = () => callback({ event: "settings://navigate", id: 0, payload: "ai" });
      return () => {};
    });
    vi.mocked(invoke).mockResolvedValueOnce("ai").mockResolvedValueOnce(null).mockResolvedValueOnce("ai");
    const activate = vi.fn();
    await connectSettingsNavigation(activate);
    expect(activate).toHaveBeenCalledWith("ai");
    wake();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(activate).toHaveBeenCalledTimes(1);
    wake();
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(2));
  });
});
