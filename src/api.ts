import type { Job, ServerEvent, Settings, SystemInfo } from "./types";

/** 對本機 Python sidecar 的 HTTP + SSE 封裝。 */
export class ApiClient {
  constructor(
    readonly baseUrl: string,
    readonly token: string,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Taigi-Token": this.token,
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = await res.json();
        detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
      } catch {
        // ignore
      }
      throw new Error(detail);
    }
    return (await res.json()) as T;
  }

  system(): Promise<SystemInfo> {
    return this.request("/api/system");
  }

  jobs(): Promise<{ jobs: Job[] }> {
    return this.request("/api/jobs");
  }

  submit(paths: string[]): Promise<{ jobs: Job[] }> {
    return this.request("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ paths }),
    });
  }

  cancel(id: string): Promise<{ ok: boolean }> {
    return this.request("/api/jobs/cancel", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
  }

  saveSettings(settings: Partial<Settings>): Promise<Settings> {
    return this.request("/api/settings", {
      method: "POST",
      body: JSON.stringify(settings),
    });
  }

  preloadModel(): Promise<{ started: boolean }> {
    return this.request("/api/model/load", { method: "POST" });
  }

  /** SSE：EventSource 不能帶自訂 header，token 走 query string。 */
  openEvents(onEvent: (e: ServerEvent) => void): EventSource {
    const es = new EventSource(`${this.baseUrl}/api/events?token=${encodeURIComponent(this.token)}`);
    es.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data) as ServerEvent);
      } catch {
        // 忽略 heartbeat / 壞訊息
      }
    };
    return es;
  }
}
