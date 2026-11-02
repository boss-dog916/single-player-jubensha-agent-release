import type { z } from "zod";
import type {
  ActSchema,
  BookletSchema,
  RoleSchema,
  ScriptSchema
} from "@/src/lib/schemas/scriptSchemas";

export type Role = z.infer<typeof RoleSchema>;
export type Booklet = z.infer<typeof BookletSchema>;
export type Act = z.infer<typeof ActSchema>;
export type Script = z.infer<typeof ScriptSchema>;

export type RoleId = Role["role_id"];
export type ActId = Act["act_id"];
