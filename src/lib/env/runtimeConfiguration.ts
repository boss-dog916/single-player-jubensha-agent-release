import { hasTaskApiKey, resolveTaskModelProfile } from "../llm/taskModelProfiles";

export function runtimeConfigurationProblems() {
  const problems: string[] = [];
  if (!hasTaskApiKey("runtime")) problems.push("未配置玩家/DM模型密钥：填写RUNTIME_LLM_API_KEY，或所选百炼/千问平台的密钥。");
  if (!hasTaskApiKey("semantic_observer")) problems.push("未配置Observer密钥。Observer需独立确认服务和模型；不会自动借用runtime密钥。");
  if (resolveTaskModelProfile().provider === "compatible") {
    for (const key of ["RUNTIME_LLM_BASE_URL", "RUNTIME_LLM_API_KEY", "RUNTIME_LLM_MODEL"]) if (!process.env[key]?.trim()) problems.push(`兼容API必须显式填写${key}。`);
  }
  if (resolveTaskModelProfile("semantic_observer").provider === "compatible") {
    for (const key of ["DM_SEMANTIC_OBSERVER_BASE_URL", "DM_SEMANTIC_OBSERVER_API_KEY", "DM_SEMANTIC_OBSERVER_MODEL"]) if (!process.env[key]?.trim()) problems.push(`Observer兼容API必须显式填写${key}，不可隐式继承其他服务。`);
  }
  return problems;
}
