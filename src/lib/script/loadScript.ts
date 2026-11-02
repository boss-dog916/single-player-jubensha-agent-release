import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import { ScriptSchema } from "@/src/lib/schemas/scriptSchemas";
import type { Script } from "@/src/lib/script/scriptTypes";

const DEFAULT_SCRIPT_PATH = join(process.cwd(), "data", "demo-script.json");

export function loadScript(scriptPath = DEFAULT_SCRIPT_PATH): Script {
  let rawJson: string;

  try {
    rawJson = readFileSync(scriptPath, "utf8");
  } catch (error) {
    throw new Error(`Failed to read script file at ${scriptPath}: ${getErrorMessage(error)}`);
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`Invalid JSON in script file at ${scriptPath}: ${getErrorMessage(error)}`);
  }

  return parseScriptJson(parsedJson, scriptPath);
}

export function parseScriptJson(value: unknown, source = "script package"): Script {
  try {
    return ScriptSchema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(`Invalid script data in ${source}:\n${formatZodError(error)}`);
    }

    throw error;
  }
}

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `- ${path}: ${issue.message}`;
    })
    .join("\n");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
