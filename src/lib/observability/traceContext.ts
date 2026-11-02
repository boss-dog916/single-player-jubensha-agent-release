import { AsyncLocalStorage } from "node:async_hooks";

export type TraceContext = {
  traceId: string;
  parentRunId: string;
};

const traceStorage = new AsyncLocalStorage<TraceContext>();

export function getTraceContext(): TraceContext | null {
  return traceStorage.getStore() ?? null;
}

export function runInTraceContext<T>(
  context: TraceContext,
  callback: () => Promise<T>
): Promise<T> {
  return traceStorage.run(context, callback);
}
