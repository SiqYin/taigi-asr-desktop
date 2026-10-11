import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ApiClient } from "./api";
import { SetupScreen } from "./setup";
import type { HostStatus } from "./types";
import { Workspace } from "./workspace";
import "./style.css";

async function main(): Promise<void> {
  const app = document.getElementById("app")!;
  let setup: SetupScreen | null = null;
  let workspace: Workspace | null = null;

  const apply = async (status: HostStatus): Promise<void> => {
    if (status.state === "ready") {
      if (!workspace) {
        workspace = new Workspace(new ApiClient(status.backend.url, status.backend.token));
        setup = null;
        await workspace.mount(app);
      }
      return;
    }

    workspace?.dispose();
    workspace = null;
    if (!setup) {
      setup = new SetupScreen();
      setup.mount(app);
    }
    setup.update(status);
  };

  const initial = await invoke<HostStatus>("get_status");
  await apply(initial);

  await listen<HostStatus>("status-changed", (event) => {
    void apply(event.payload);
  });
}

main().catch((err) => {
  document.getElementById("app")!.textContent = `啟動失敗：${String(err)}`;
});
