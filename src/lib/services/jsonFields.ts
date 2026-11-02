import type { Prisma } from "@prisma/client";

export function toJsonInput<T>(value: T): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({
      serialization_error: "Value could not be serialized to JSON."
    });
  }
}

export function fromJsonValue<T>(
  value: Prisma.JsonValue | string | null | undefined,
  fallback: T
): T {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  return value as T;
}
