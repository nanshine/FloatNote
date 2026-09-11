import { describe, expect, it, vi } from "vitest";
import { createUpdateController } from "./controller";

function fixture() {
  const deps = {
    check: vi.fn().mockResolvedValue({ configured: true, currentVersion: "0.1.0", version: "0.2.0", notes: "Fix" }),
    download: vi.fn().mockResolvedValue(undefined), confirm: vi.fn().mockResolvedValue(true),
    prepare: vi.fn().mockResolvedValue(undefined), save: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined), release: vi.fn().mockResolvedValue(undefined),
    freeze: vi.fn(), publish: vi.fn(), notify: vi.fn(),
  };
  return { deps, controller: createUpdateController(deps) };
}
describe("application updates", () => {
  it("keeps automatic network failures quiet and reports manual failures", async () => {
    const { deps, controller } = fixture();
    deps.check.mockRejectedValue(new Error("offline"));
    await controller.check();
    expect(deps.publish).not.toHaveBeenCalled();
    await controller.check(true);
    expect(deps.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "error", error: "Error: offline" }));
  });
  it("notifies once per version and never downloads without confirmation", async () => {
    const { deps, controller } = fixture();
    await controller.check(); await controller.check();
    expect(deps.notify).toHaveBeenCalledTimes(1);
    deps.confirm.mockResolvedValue(false);
    await controller.install();
    expect(deps.download).not.toHaveBeenCalled();
  });
  it("does not prepare or install a failed download or signature", async () => {
    const { deps, controller } = fixture();
    await controller.check();
    deps.download.mockRejectedValue(new Error("bad signature"));
    await controller.install();
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.install).not.toHaveBeenCalled();
  });
  it("refuses installation after a failed save and releases the agent gate", async () => {
    const { deps, controller } = fixture();
    await controller.check();
    deps.save.mockRejectedValue(new Error("unsaved note"));
    await controller.install();
    expect(deps.install).not.toHaveBeenCalled();
    expect(deps.release).toHaveBeenCalledOnce();
    expect(deps.freeze.mock.calls).toEqual([[true], [false]]);
    deps.save.mockResolvedValue(undefined);
    await controller.install();
    expect(deps.install).toHaveBeenCalledOnce();
  });
  it("waits for save completion and ignores concurrent installation requests", async () => {
    const { deps, controller } = fixture();
    await controller.check();
    let finish!: () => void;
    deps.save.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const operation = controller.install();
    await vi.waitFor(() => expect(deps.save).toHaveBeenCalledOnce());
    await controller.install();
    expect(deps.download).toHaveBeenCalledOnce();
    expect(deps.install).not.toHaveBeenCalled();
    finish(); await operation;
    expect(deps.install).toHaveBeenCalledOnce();
  });
});
