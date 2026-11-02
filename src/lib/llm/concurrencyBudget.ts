import { AsyncLocalStorage } from "node:async_hooks";
import { RUNTIME_BASELINE } from "@/src/lib/env/runtimeBaseline";

type BudgetState = {
  priorityScope: AsyncLocalStorage<number>;
  waiting: Array<{ priority: number; resolve: (release: () => void) => void }>;
  active: number;
};
const globalBudget = globalThis as typeof globalThis & { jubenshaLlmBudget?: BudgetState; jubenshaBailianBudget?: BudgetState; jubenshaBackgroundBudget?: BudgetState };
const budget = globalBudget.jubenshaLlmBudget ??= { priorityScope: new AsyncLocalStorage<number>(), waiting: [], active: 0 };
const parserBudget = globalBudget.jubenshaBailianBudget ??= { priorityScope: budget.priorityScope, waiting: [], active: 0 };
// One non-critical board request cannot occupy the foreground provider slot.
const backgroundBudget = globalBudget.jubenshaBackgroundBudget ??= { priorityScope: budget.priorityScope, waiting: [], active: 0 };
const { priorityScope } = budget;

export function withLlmPriority<T>(priority: number, operation: () => Promise<T>): Promise<T> {
  return priorityScope.run(priority, operation);
}

export async function withLlmBudget<T>(operation: () => Promise<T>, provider: "bupt" | "bailian" | "compatible" = "bailian", signal?: AbortSignal,
  lane: "foreground" | "background" = "foreground"): Promise<T> {
  const state = lane === "background" ? backgroundBudget : provider === "bailian" ? parserBudget : budget;
  const limit = lane === "background" ? RUNTIME_BASELINE.backgroundConcurrency : RUNTIME_BASELINE.foregroundConcurrency;
  signal?.throwIfAborted();
  const release = await new Promise<() => void>((resolve, reject) => {
    const waiter = { priority: priorityScope.getStore() ?? 0, resolve: (free: () => void) => {
      signal?.removeEventListener("abort", cancel);
      resolve(free);
    } };
    const cancel = () => {
      state.waiting = state.waiting.filter(w => w !== waiter);
      reject(signal?.reason ?? new Error("LLM request aborted"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    state.waiting.push(waiter);
    state.waiting.sort((a, b) => a.priority - b.priority);
    pump(state, limit);
  });
  let cancel: (() => void) | undefined;
  try {
    signal?.throwIfAborted();
    if (!signal) return await operation();
    const aborted = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason ?? new Error("LLM request aborted"));
      signal.addEventListener("abort", cancel, { once: true });
    });
    return await Promise.race([operation(), aborted]);
  } finally {
    if (cancel) signal?.removeEventListener("abort", cancel);
    release();
  }
}

function pump(state: BudgetState, limit: number) {
  while (state.active < limit && state.waiting.length > 0) {
    state.active += 1;
    state.waiting.shift()!.resolve(() => { state.active -= 1; pump(state, limit); });
  }
}
