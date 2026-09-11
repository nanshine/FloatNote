import type { UpdateInfo, UpdateProgress, UpdateStatus } from "../../platform/updates";

interface Dependencies {
  check: () => Promise<UpdateInfo>;
  download: (progress: (value: UpdateProgress) => void) => Promise<void>;
  confirm: () => Promise<boolean>;
  prepare: () => Promise<void>;
  save: () => Promise<void>;
  install: () => Promise<void>;
  release: () => Promise<void>;
  freeze: (frozen: boolean) => void;
  publish: (status: UpdateStatus) => void;
  notify: (version: string) => void;
}

/** One controller in the persistent main webview owns every update operation. */
export function createUpdateController(deps: Dependencies) {
  let status: UpdateStatus = { phase: "idle" };
  let busy = false;
  let notifiedVersion: string | undefined;
  const publish = (next: UpdateStatus) => { status = next; deps.publish(status); };
  return {
    snapshot: () => deps.publish(status),
    async check(manual = false) {
      if (busy) return;
      busy = true;
      const previous = status;
      if (manual) publish({ ...status, phase: "checking", error: undefined });
      try {
        const info = await deps.check();
        publish({ phase: info.version ? "available" : "idle", info });
        if (!manual && info.version && info.version !== notifiedVersion) {
          notifiedVersion = info.version;
          deps.notify(info.version);
        }
      } catch (error) {
        if (manual) publish({ ...previous, phase: "error", error: String(error) });
      } finally { busy = false; }
    },
    async install() {
      if (busy || !status.info?.version) return;
      busy = true;
      let prepared = false;
      let frozen = false;
      try {
        if (!await deps.confirm()) return;
        publish({ ...status, phase: "downloading", error: undefined, progress: undefined });
        await deps.download((progress) => publish({ ...status, progress }));
        await deps.prepare();
        prepared = true;
        frozen = true;
        deps.freeze(true);
        publish({ ...status, phase: "preparing" });
        await deps.save();
        publish({ ...status, phase: "installing" });
        await deps.install();
      } catch (error) {
        publish({ ...status, phase: "error", error: String(error) });
      } finally {
        if (prepared) {
          try { await deps.release(); }
          catch (error) { publish({ ...status, phase: "error", error: `无法解除更新锁，请重启应用：${String(error)}` }); }
        }
        if (frozen) deps.freeze(false);
        busy = false;
      }
    },
  };
}
