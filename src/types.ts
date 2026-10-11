export type HostStatus =
  | { state: "preparing"; phase: string; message: string; fraction: number | null }
  | { state: "ready"; backend: { url: string; token: string } }
  | { state: "error"; message: string };

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export type JobState =
  | "queued"
  | "converting"
  | "loading"
  | "transcribing"
  | "writing"
  | "done"
  | "error"
  | "cancelled";

export interface Job {
  id: string;
  input_path: string;
  status: JobState;
  progress: number;
  message: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  duration: number | null;
  outputs: string[];
  segments: Segment[];
  error: string | null;
}

export interface Settings {
  formats: string[];
  beam_size: number;
  word_timestamps: boolean;
  output_dir: string;
}

export interface Hardware {
  device: "cuda" | "cpu";
  compute_type: string;
  batch_size: number;
  cpu_threads: number;
  gpu_name: string;
  vram_gb: number;
}

export interface SystemInfo {
  hardware: Hardware | null;
  model_loaded: boolean;
  model_id: string;
  formats: string[];
}

export type ServerEvent =
  | { type: "hello"; jobs: Job[]; settings: Settings; hardware: Hardware | null; model_loaded: boolean }
  | { type: "job"; job: Job }
  | { type: "settings"; settings: Settings }
  | { type: "system"; message: string; runner_state?: string; hardware?: Hardware };
