import { afterEach, expect, it, vi } from "vitest";
import { runtimeConfigurationProblems } from "./runtimeConfiguration";
afterEach(() => vi.unstubAllEnvs());
it("does not silently borrow runtime credentials for a missing Observer", () => {
  for (const key of ["BAILIAN_API_KEY", "OPENAI_API_KEY", "DM_SEMANTIC_OBSERVER_API_KEY"]) vi.stubEnv(key, "");
  vi.stubEnv("RUNTIME_LLM_PROVIDER", "compatible"); vi.stubEnv("RUNTIME_LLM_API_KEY", "user-runtime-key");
  vi.stubEnv("RUNTIME_LLM_BASE_URL", "https://fixture.invalid/v1"); vi.stubEnv("RUNTIME_LLM_MODEL", "runtime-model");
  vi.stubEnv("DM_SEMANTIC_OBSERVER_PROVIDER", "compatible"); vi.stubEnv("DM_SEMANTIC_OBSERVER_BASE_URL", ""); vi.stubEnv("DM_SEMANTIC_OBSERVER_MODEL", "");
  const problems = runtimeConfigurationProblems();
  expect(problems.some(problem => problem.includes("Observer"))).toBe(true);
  expect(problems.some(problem => problem.includes("DM_SEMANTIC_OBSERVER_BASE_URL"))).toBe(true);
  expect(problems.some(problem => problem.includes("user-runtime-key"))).toBe(false);
});
it("accepts explicitly configured independent compatible routes", () => {
  for (const prefix of ["RUNTIME_LLM", "DM_SEMANTIC_OBSERVER"]) {
    vi.stubEnv(`${prefix}_PROVIDER`, "compatible"); vi.stubEnv(`${prefix}_BASE_URL`, "https://fixture.invalid/v1");
    vi.stubEnv(`${prefix}_API_KEY`, "offline-only"); vi.stubEnv(`${prefix}_MODEL`, "user-model");
  }
  expect(runtimeConfigurationProblems()).toEqual([]);
});
