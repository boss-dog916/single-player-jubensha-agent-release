import type { Script } from "@/src/lib/script/scriptTypes";

export type ValidationIssueLevel = "error" | "warning";

export type ValidationIssue = {
  level: ValidationIssueLevel;
  path: string;
  message: string;
};

export type ValidationReport = {
  status: "valid" | "warning" | "invalid";
  issues: ValidationIssue[];
  checkedAt: string;
};

export function validateScriptPackageScript(script: Script): ValidationReport {
  const issues: ValidationIssue[] = [];
  const roleIds = new Set(script.roles.map((role) => role.role_id));

  if (script.roles.length === 0) {
    issues.push({
      level: "error",
      path: "roles",
      message: "剧本至少需要一个角色。"
    });
  }

  if (script.acts.length === 0) {
    issues.push({
      level: "error",
      path: "acts",
      message: "剧本至少需要一幕。"
    });
  }

  script.acts.forEach((act, actIndex) => {
    if (act.booklets.length === 0) {
      issues.push({
        level: "error",
        path: `acts.${actIndex}.booklets`,
        message: "每一幕都需要角色本。"
      });
    }

    script.roles.forEach((role) => {
      const booklet = act.booklets.find((candidate) => candidate.role_id === role.role_id);

      if (!booklet) {
        issues.push({
          level: "error",
          path: `acts.${actIndex}.booklets.${role.role_id}`,
          message: `缺少角色 ${role.name} 的本幕角色本。`
        });
        return;
      }

      if (!booklet.private_text.trim()) {
        issues.push({
          level: "error",
          path: `acts.${actIndex}.booklets.${role.role_id}.private_text`,
          message: `角色 ${role.name} 缺少可阅读文本。`
        });
      }
    });

    if (act.share_order.length === 0) {
      issues.push({
        level: "warning",
        path: `acts.${actIndex}.share_order`,
        message: "本幕没有分享顺序，Runtime 可能只能依赖兜底流程推进。"
      });
    }

    act.share_order.forEach((roleId, orderIndex) => {
      if (!roleIds.has(roleId)) {
        issues.push({
          level: "error",
          path: `acts.${actIndex}.share_order.${orderIndex}`,
          message: `分享顺序引用了不存在的角色 ${roleId}。`
        });
      }
    });

    if (act.dm_flow === undefined) {
      issues.push({
        level: "warning",
        path: `acts.${actIndex}.dm_flow`,
        message: "本幕缺少 dm_flow，Runtime 会使用系统 fallback DM 文案。"
      });
    }
  });

  const scriptRecord = script as Script & {
    clues?: unknown;
    safety?: unknown;
    forbidden?: unknown;
    visibility?: unknown;
  };

  if (scriptRecord.clues !== undefined && !Array.isArray(scriptRecord.clues)) {
    issues.push({
      level: "error",
      path: "clues",
      message: "clues 字段如果存在，必须是数组。"
    });
  }

  if (scriptRecord.clues === undefined) {
    issues.push({
      level: "warning",
      path: "clues",
      message: "当前结构中没有 clues 字段；阶段 1 允许缺省，后续线索 Pipeline 应补齐。"
    });
  }

  if (
    scriptRecord.safety === undefined &&
    scriptRecord.forbidden === undefined &&
    scriptRecord.visibility === undefined
  ) {
    issues.push({
      level: "warning",
      path: "safety",
      message: "当前结构中没有独立 safety/forbidden/visibility 字段；将使用角色本 must_not_share 作为最小防剧透边界。"
    });
  }

  return {
    status: issues.some((issue) => issue.level === "error")
      ? "invalid"
      : issues.some((issue) => issue.level === "warning")
        ? "warning"
        : "valid",
    issues,
    checkedAt: new Date().toISOString()
  };
}
