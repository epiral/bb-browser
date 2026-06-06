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

export class BindingStore {
  private data: Record<string, TabBinding> = {};

  constructor(private readonly store: StateStore) {
    this.load();
  }

  upsert(binding: TabBinding): void {
    this.data[binding.bbTabId] = binding;
    this.save();
  }

  updateProgress(bbTabId: string, progress: string): boolean {
    const b = this.data[bbTabId];
    if (!b) return false;
    b.progress = progress;
    b.updatedAt = Date.now();
    this.save();
    return true;
  }

  remove(bbTabId: string): void {
    if (bbTabId in this.data) {
      delete this.data[bbTabId];
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
    this.data = file?.bindings ?? {};
  }

  private save(): void {
    this.store.write("bindings.json", { bindings: this.data });
  }
}
