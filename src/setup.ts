import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { HostStatus } from "./types";

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const child of children) {
    el.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return el;
}

const STEPS: { phase: string; label: string }[] = [
  { phase: "python", label: "準備 Python 執行環境" },
  { phase: "venv", label: "建立虛擬環境" },
  { phase: "deps", label: "安裝轉錄依賴" },
  { phase: "gpu", label: "安裝 GPU 加速元件" },
  { phase: "model", label: "下載台語辨識模型（約 2.9 GB）" },
  { phase: "launch", label: "啟動辨識引擎" },
];

function phaseRank(phase: string): number {
  const i = STEPS.findIndex((s) => s.phase === phase);
  return i === -1 ? STEPS.length - 1 : i;
}

export class SetupScreen {
  private root!: HTMLElement;
  private stepEls: Record<string, HTMLElement> = {};
  private msgEl!: HTMLElement;
  private barEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private retryBtn!: HTMLButtonElement;

  mount(parent: HTMLElement): void {
    const steps = h(
      "div",
      { class: "setup-steps" },
      ...STEPS.map((s, i) => {
        const item = h("div", { class: "setup-step", id: `step-${s.phase}` },
          h("span", { class: "step-dot", text: String(i + 1) }),
          h("span", { class: "step-label", text: s.label }),
        );
        this.stepEls[s.phase] = item;
        return item;
      }),
    );

    this.msgEl = h("div", { class: "setup-msg muted", text: "啟動中…" });
    this.barEl = h("div", { class: "setup-bar" }, h("div", { class: "setup-bar-fill indeterminate" }));

    this.retryBtn = h("button", { class: "btn btn-primary", type: "button", text: "重試" }) as HTMLButtonElement;
    this.retryBtn.addEventListener("click", async () => {
      this.retryBtn.disabled = true;
      try {
        await invoke("retry_setup");
      } finally {
        setTimeout(() => (this.retryBtn.disabled = false), 1000);
      }
    });
    const logBtn = h("button", { class: "btn btn-ghost", type: "button", text: "開啟日誌資料夾" });
    logBtn.addEventListener("click", async () => {
      const p = await invoke<string>("log_file_path");
      await revealItemInDir(p);
    });
    this.errorEl = h("div", { class: "setup-error-wrap hidden" },
      h("div", { class: "setup-error" }),
      h("div", { class: "setup-actions" }, this.retryBtn, logBtn),
    );

    this.root = h("div", { class: "setup" },
      h("div", { class: "setup-card" },
        h("div", { class: "setup-logo", text: "台" }),
        h("h1", { text: "台語語音轉錄" }),
        h("div", { class: "muted setup-tagline", text: "首次啟動須準備本機辨識環境，完成後可離線使用" }),
        steps,
        this.barEl,
        this.msgEl,
        this.errorEl,
      ),
    );
    parent.replaceChildren(this.root);
  }

  update(status: Extract<HostStatus, { state: "preparing" }> | Extract<HostStatus, { state: "error" }>): void {
    if (status.state === "error") {
      this.errorEl.classList.remove("hidden");
      this.errorEl.querySelector(".setup-error")!.textContent = status.message;
      this.barEl.replaceChildren(h("div", { class: "setup-bar-fill", style: "width:100%; background:var(--danger)" }));
      this.msgEl.textContent = "準備過程發生錯誤";
      for (const el of Object.values(this.stepEls)) el.classList.add("step-fail");
      return;
    }

    this.errorEl.classList.add("hidden");
    const rank = phaseRank(status.phase);
    STEPS.forEach((s, i) => {
      const el = this.stepEls[s.phase];
      el.classList.toggle("step-active", i === rank);
      el.classList.toggle("step-done", i < rank);
    });

    this.msgEl.textContent = status.message || status.phase;
    if (status.fraction != null) {
      this.barEl.replaceChildren(
        h("div", { class: "setup-bar-fill", style: `width:${Math.round(status.fraction * 100)}%` }),
      );
    } else {
      this.barEl.replaceChildren(h("div", { class: "setup-bar-fill indeterminate" }));
    }
  }
}
