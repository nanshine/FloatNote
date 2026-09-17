import { afterEach, expect, it, vi } from "vitest";
import { withAppState } from "./startup";
afterEach(() => vi.useRealTimers());
it("waits for managed state and returns the configuration", async () => {
  vi.useFakeTimers();
  const request = vi.fn().mockRejectedValueOnce("state not managed for field `state`").mockResolvedValue({ working_dir: null });
  const result = withAppState(request);
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toEqual({ working_dir: null });
  expect(request).toHaveBeenCalledTimes(2);
});
it("does not retry filesystem or configuration errors", async () => {
  const request = vi.fn().mockRejectedValue("permission denied");
  await expect(withAppState(request)).rejects.toBe("permission denied");
  expect(request).toHaveBeenCalledTimes(1);
});
it("stops waiting when setup never finishes", async () => {
  vi.useFakeTimers();
  const request = vi.fn().mockRejectedValue("state not managed");
  const assertion = expect(withAppState(request)).rejects.toBe("state not managed");
  await vi.advanceTimersByTimeAsync(15_000);
  await assertion;
});
