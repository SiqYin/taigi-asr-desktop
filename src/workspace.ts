import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ApiClient } from "./api";
import type { Hardware, Job, JobState, ServerEvent, Settings } from "./types";

const STATUS_LABEL: Record<JobState, string> = {
  queued: "等待中",
  converting: "解碼音訊",
  loading: "載入模型",
  transcribing: "辨識中",
  writing: "輸出檔案",
  done: "完成",
  error: "失敗",
  cancelled: "已取消",
};

const AUDIO_VIDEO_EXTENSIONS = [
  "mp3", "m4a", "wav", "flac", "ogg", "webm", "mp4", "mkv",
  "mov", "aac", "opus", "wma", "avi", "aiff", "3gp", "ts",
];

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "text") el.textContent = String(v);
    else if (k.startsWith("data-")) el.setAttribute(k, String(v));
    else el.setAttribute(k, String(v));
  }
  for (const child of children) {
    el.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return el;
}

function basename(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;
}

function dirname(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  parts.pop();
  return parts.join("\\");
}

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return hh > 0
    ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${mm}:${String(ss).padStart(2, "0")}`;
}

export class Workspace {
  private root: HTMLElement;
  private jobs = new Map<string, Job>();
  private staged: string[] = [];
  private expanded = new Set<string>();
  private settings: Settings | null = null;
  private hardware: Hardware | null = null;
  private modelState: string = "idle";
  private es: EventSource | null = null;

  private jobsEl!: HTMLElement;
  private stagedEl!: HTMLElement;
  private startBtn!: HTMLButtonElement;
  private dropEl!: HTMLElement;
  private hwBadgeEl!: HTMLElement;
  private modelBadgeEl!: HTMLElement;

  constructor(
    private readonly api: ApiClient,
  ) {
    this.root = h("main", { class: "workspace" });
  }

  async mount(parent: HTMLElement): Promise<void> {
    const [sys, jobsData] = await Promise.all([
      this.api.system(),
      this.api.jobs(),
      this.refreshSettings(),
    ]);
    this.hardware = sys.hardware;
    this.modelState = sys.model_loaded ? "loaded" : "idle";
    for (const j of jobsData.jobs) this.jobs.set(j.id, j);

    this.renderScaffold();
    parent.replaceChildren(this.root);
    this.bindDragDrop();
    this.renderHeader();
    this.renderJobs();
    this.renderStaged();

    this.es = this.api.openEvents((e) => this.onEvent(e));
  }

  dispose(): void {
    this.es?.close();
  }

  // ---------- scaffold ----------

  private renderScaffold(): void {
    const header = h("header", { class: "topbar" },
      h("div", { class: "brand" },
        h("div", { class: "brand-title", text: "台語語音轉錄" }),
        h("div", { class: "brand-sub", text: "Breeze-ASR-26 · 影片／音訊 → SRT / VTT / TXT / JSON" }),
      ),
      h("div", { class: "badges" },
        (this.hwBadgeEl = h("span", { class: "badge badge-hw", text: "硬體偵測中…" })),
        (this.modelBadgeEl = h("button", {
          class: "badge badge-model state-idle",
          type: "button",
          title: "提前把模型載入記憶體（約 2.9 GB）",
          text: "模型：未載入",
        })),
      ),
    );
    this.modelBadgeEl.addEventListener("click", () => this.preloadModel());

    const options = this.buildOptions();
    this.dropEl = h("div", { class: "dropzone", tabindex: "0" },
      h("div", { class: "drop-icon", text: "⬓" }),
      h("div", { class: "drop-text", text: "把台語影片／音訊拖到這裡" }),
      h("div", { class: "drop-sub" },
        h("button", { class: "btn btn-primary", type: "button", text: "選擇檔案…" }),
      ),
    );
    this.dropEl.querySelector("button")!.addEventListener("click", () => this.pickFiles());
    this.dropEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") this.pickFiles();
    });

    this.stagedEl = h("div", { class: "staged" });
    this.startBtn = h("button", { class: "btn btn-go", type: "button", text: "開始轉錄", disabled: true }) as HTMLButtonElement;
    this.startBtn.addEventListener("click", () => this.startJobs());

    const dropCard = h("section", { class: "card drop-card" },
      this.dropEl,
      h("div", { class: "staged-head" },
        h("span", { class: "muted", text: "待處理" }),
        this.startBtn,
      ),
      this.stagedEl,
    );

    this.jobsEl = h("div", { class: "jobs" });
    const jobsCard = h("section", { class: "card" },
      h("div", { class: "card-head", text: "轉錄任務" }),
      this.jobsEl,
    );

    this.root.append(header, options, dropCard, jobsCard);
  }

  private buildOptions(): HTMLElement {
    const formats = h("div", { class: "opt-group" },
      h("label", { class: "opt-label", text: "輸出格式" }),
      ...["srt", "vtt", "txt", "json"].map((f) => {
        const id = `fmt-${f}`;
        const input = h("input", { type: "checkbox", id, value: f }) as HTMLInputElement;
        input.checked = this.settings?.formats.includes(f) ?? f === "srt";
        input.addEventListener("change", () => {
          const picked = [...(this.dropCardOwner().querySelectorAll<HTMLInputElement>("input[id^=fmt-]:checked"))].map((x) => x.value);
          this.patchSettings({ formats: picked.length ? picked : ["srt"] });
        });
        return h("label", { class: "chip-check", for: id }, input, h("span", { text: f.toUpperCase() }));
      }),
    );

    const beam = h("div", { class: "opt-group" },
      h("label", { class: "opt-label", for: "beam", text: "Beam size" }),
      (() => {
        const select = h("select", { id: "beam" },
          ...[1, 3, 5, 10].map((v) =>
            h("option", { value: String(v), ...(this.settings?.beam_size === v ? { selected: true } : {}) },
              `${v}（${v === 1 ? "最快" : v === 10 ? "最精細" : "均衡"}）`)),
        ) as HTMLSelectElement;
        select.value = String(this.settings?.beam_size ?? 5);
        select.addEventListener("change", () => this.patchSettings({ beam_size: Number(select.value) }));
        return select;
      })(),
    );

    const wordt = h("div", { class: "opt-group opt-inline" },
      (() => {
        const id = "word-ts";
        const input = h("input", { type: "checkbox", id }) as HTMLInputElement;
        input.checked = this.settings?.word_timestamps ?? false;
        input.addEventListener("change", () => this.patchSettings({ word_timestamps: input.checked }));
        return h("label", { class: "chip-check", for: id }, input, h("span", { text: "逐字時間戳記（較慢）" }));
      })(),
    );

    const outPath = h("span", { class: "out-path muted", text: this.settings?.output_dir || "預設：跟影片放同一個資料夾" });
    const outBtn = h("button", { class: "btn btn-ghost", type: "button", text: "選擇輸出資料夾…" });
    outBtn.addEventListener("click", async () => {
      const dir = await open({ directory: true, multiple: false, title: "選擇字幕輸出資料夾" });
      if (typeof dir === "string") {
        await this.patchSettings({ output_dir: dir });
        outPath.textContent = dir;
      }
    });
    const clearBtn = h("button", { class: "btn btn-ghost btn-sm", type: "button", text: "重設" });
    clearBtn.addEventListener("click", async () => {
      await this.patchSettings({ output_dir: "" });
      outPath.textContent = "預設：跟影片放同一個資料夾";
    });
    const output = h("div", { class: "opt-group opt-output" },
      h("label", { class: "opt-label", text: "輸出位置" }),
      h("div", { class: "out-row" }, outBtn, outPath, clearBtn),
    );

    return h("section", { class: "card options" }, formats, beam, wordt, output);
  }

  /** options 區塊並非以 this 持有，用 root 查找 checkbox 群。 */
  private dropCardOwner(): HTMLElement {
    return this.root;
  }

  // ---------- data ----------

  private async refreshSettings(): Promise<void> {
    try {
      const res = await fetch(`${this.api.baseUrl}/api/settings`, {
        headers: { "X-Taigi-Token": this.api.token },
      });
      this.settings = (await res.json()) as Settings;
    } catch {
      this.settings = null;
    }
  }

  private async patchSettings(patch: Partial<Settings>): Promise<void> {
    try {
      this.settings = await this.api.saveSettings(patch);
    } catch (e) {
      this.toast(`設定未儲存：${(e as Error).message}`);
    }
  }

  private async preloadModel(): Promise<void> {
    if (this.modelState === "loaded" || this.modelState === "loading") return;
    try {
      await this.api.preloadModel();
      this.modelState = "loading";
      this.renderHeader();
    } catch (e) {
      this.toast((e as Error).message);
    }
  }

  private async pickFiles(): Promise<void> {
    const picked = await open({
      multiple: true,
      title: "選擇台語影片／音訊",
      filters: [{ name: "音訊／影片", extensions: AUDIO_VIDEO_EXTENSIONS }],
    });
    if (Array.isArray(picked)) this.addStaged(picked);
  }

  private addStaged(paths: string[]): void {
    const existing = new Set(this.staged);
    for (const p of paths) {
      if (!existing.has(p)) this.staged.push(p);
    }
    this.renderStaged();
  }

  private removeStaged(p: string): void {
    this.staged = this.staged.filter((x) => x !== p);
    this.renderStaged();
  }

  private async startJobs(): Promise<void> {
    const paths = [...this.staged];
    if (!paths.length) return;
    this.startBtn.disabled = true;
    try {
      await this.api.submit(paths);
      this.staged = [];
      this.renderStaged();
    } catch (e) {
      this.toast(`無法送出任務：${(e as Error).message}`);
      this.startBtn.disabled = false;
    }
  }

  private bindDragDrop(): void {
    let depth = 0;
    getCurrentWindow().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter" || payload.type === "over") {
        depth = payload.type === "enter" ? 1 : depth;
        this.dropEl.classList.add("dragging");
      } else if (payload.type === "leave") {
        depth = 0;
        this.dropEl.classList.remove("dragging");
      } else if (payload.type === "drop") {
        depth = 0;
        this.dropEl.classList.remove("dragging");
        if (payload.paths?.length) this.addStaged(payload.paths);
      }
    });
  }

  // ---------- rendering ----------

  private renderHeader(): void {
    if (this.hardware) {
      const hw = this.hardware;
      this.hwBadgeEl.textContent =
        hw.device === "cuda"
          ? `GPU · ${hw.gpu_name}（${hw.vram_gb.toFixed(1)} GB / ${hw.compute_type}）`
          : `CPU 模式（${hw.compute_type}）`;
      this.hwBadgeEl.classList.toggle("badge-gpu", hw.device === "cuda");
    } else {
      this.hwBadgeEl.textContent = "硬體偵測中…";
    }
    const label = this.modelState === "loaded"
      ? "模型：已載入"
      : this.modelState === "loading"
        ? "模型：載入中…"
        : "模型：未載入（點此預載）";
    this.modelBadgeEl.textContent = label;
    this.modelBadgeEl.className = `badge badge-model state-${this.modelState}`;
  }

  private renderStaged(): void {
    this.stagedEl.replaceChildren();
    if (this.staged.length === 0) {
      this.startBtn.disabled = true;
      return;
    }
    for (const p of this.staged) {
      const remove = h("button", { class: "chip-x", type: "button", title: "移除", text: "×" });
      remove.addEventListener("click", () => this.removeStaged(p));
      this.stagedEl.append(
        h("div", { class: "chip" },
          h("span", { class: "chip-name", text: basename(p) }),
          remove,
        ),
      );
    }
    this.startBtn.disabled = false;
  }

  private renderJobs(): void {
    this.jobsEl.replaceChildren();
    const jobs = [...this.jobs.values()].sort((a, b) => a.created_at - b.created_at);
    if (jobs.length === 0) {
      this.jobsEl.append(h("div", { class: "empty", text: "尚無任務。加入影片或音訊後按「開始轉錄」。" }));
      return;
    }
    for (const job of jobs) this.jobsEl.append(this.renderJob(job));
  }

  private renderJob(job: Job): HTMLElement {
    const active = ["queued", "converting", "loading", "transcribing", "writing"].includes(job.status);
    const pct = Math.round(job.progress * 100);

    const actions: HTMLElement[] = [];
    if (active) {
      const cancel = h("button", { class: "btn btn-ghost btn-sm", type: "button", text: "取消" });
      cancel.addEventListener("click", () => this.api.cancel(job.id).catch((e) => this.toast((e as Error).message)));
      actions.push(cancel);
    }
    for (const out of job.outputs) {
      const btn = h("button", {
        class: "btn btn-out btn-sm",
        type: "button",
        title: out,
        text: `開啟 ${out.split(".").pop()?.toUpperCase()}`,
      });
      btn.addEventListener("click", () => revealItemInDir(out));
      actions.push(btn);
    }

    const meta: string[] = [];
    if (job.duration) meta.push(`長度 ${fmtClock(job.duration)}`);
    if (job.started_at) {
      const end = job.finished_at ?? Date.now() / 1000;
      meta.push(`耗時 ${fmtClock(end - job.started_at)}`);
    }

    const bar = active || job.status === "done"
      ? h("div", { class: "bar" }, h("div", { class: `bar-fill bar-${job.status}`, style: `width:${pct}%` }))
      : h("div");

    const head = h("div", { class: "job-head" },
      h("span", { class: `dot dot-${job.status}` }),
      h("div", { class: "job-name" },
        h("div", { class: "job-file", text: basename(job.input_path) }),
        h("div", { class: "job-dir muted", text: dirname(job.input_path) }),
      ),
      h("div", { class: "job-spacer" }),
      h("div", { class: "job-status" },
        h("div", { class: `status-text st-${job.status}`, text: STATUS_LABEL[job.status] }),
        h("div", { class: "job-meta muted", text: meta.join(" · ") }),
      ),
      h("div", { class: "job-actions" }, ...actions),
    );

    const parts: Node[] = [head, bar];
    if (active) parts.push(h("div", { class: "job-msg muted", text: job.message }));
    if (job.error) parts.push(h("div", { class: "job-error", text: job.error }));
    if (job.segments.length > 0) {
      const expanded = this.expanded.has(job.id);
      const toggle = h("button", { class: "btn btn-ghost btn-sm", type: "button",
        text: expanded ? "收合逐字稿" : `檢視逐字稿（${job.segments.length} 句）` });
      const body = h("div", { class: "transcript" + (expanded ? "" : " collapsed") },
        ...job.segments.map((s) => h("div", { class: "seg" },
          h("span", { class: "seg-time", text: fmtClock(s.start) }),
          h("span", { class: "seg-text", text: s.text }),
        )),
      );
      toggle.addEventListener("click", () => {
        if (this.expanded.has(job.id)) this.expanded.delete(job.id);
        else this.expanded.add(job.id);
        this.renderJobs();
      });
      parts.push(h("div", { class: "seg-toggle" }, toggle));
      if (expanded) parts.push(body);
    }

    return h("div", { class: `job job-${job.status}` }, ...parts);
  }

  private onEvent(e: ServerEvent): void {
    switch (e.type) {
      case "hello":
        this.jobs.clear();
        for (const j of e.jobs) this.jobs.set(j.id, j);
        this.settings = e.settings;
        this.hardware = e.hardware;
        this.modelState = e.model_loaded ? "loaded" : "idle";
        this.renderHeader();
        this.renderJobs();
        break;
      case "job":
        this.jobs.set(e.job.id, e.job);
        this.renderJobs();
        break;
      case "settings":
        this.settings = e.settings;
        break;
      case "system":
        if (e.hardware) this.hardware = e.hardware;
        if (e.runner_state) this.modelState = e.runner_state;
        this.renderHeader();
        break;
    }
  }

  // ---------- toast ----------

  private toast(text: string): void {
    const t = h("div", { class: "toast", text });
    document.body.append(t);
    setTimeout(() => t.classList.add("show"), 10);
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 300);
    }, 4000);
  }
}
