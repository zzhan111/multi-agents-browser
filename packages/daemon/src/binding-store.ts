import type { StateStore } from "./state-store.js";

export interface TabBinding {
  bbTabId: string;
  agentId: string;
  anchorUrl: string;
  intent?: string;
  progress?: string;
  claimedAt: number;
  updatedAt: number;
}

interface BindingsFile {
  bindings: Record<string, TabBinding>;
}

/** Stable key: survives browser restarts (bbTabId changes; agentId+anchorUrl don't). */
function bindingKey(agentId: string, anchorUrl: string): string {
  return `${agentId}::${anchorUrl}`;
}

export class BindingStore {
  private data: Record<string, TabBinding> = {};

  constructor(private readonly store: StateStore) {
    this.load();
  }

  upsert(binding: TabBinding): void {
    const key = bindingKey(binding.agentId, binding.anchorUrl);
    const existing = this.data[key];
    // Preserve original claimedAt on re-claim; update bbTabId to the new live one.
    this.data[key] = existing
      ? { ...existing, ...binding, claimedAt: existing.claimedAt }
      : binding;
    this.save();
  }

  updateProgress(bbTabId: string, progress: string): boolean {
    const entry = Object.values(this.data).find((b) => b.bbTabId === bbTabId);
    if (!entry) return false;
    entry.progress = progress;
    entry.updatedAt = Date.now();
    this.save();
    return true;
  }

  remove(bbTabId: string): void {
    const key = Object.keys(this.data).find((k) => this.data[k].bbTabId === bbTabId);
    if (key) {
      delete this.data[key];
      this.save();
    }
  }

  all(): TabBinding[] {
    return Object.values(this.data);
  }

  forAgent(agentId: string): TabBinding[] {
    return Object.values(this.data).filter((b) => b.agentId === agentId);
  }

  private load(): void {
    const file = this.store.read<BindingsFile>("bindings.json");
    if (!file?.bindings) return;
    // Re-key old data (keyed by bbTabId) to the new stable key format.
    for (const b of Object.values(file.bindings)) {
      const key = bindingKey(b.agentId, b.anchorUrl);
      this.data[key] = b;
    }
  }

  private save(): void {
    this.store.write("bindings.json", { bindings: this.data });
  }
}
