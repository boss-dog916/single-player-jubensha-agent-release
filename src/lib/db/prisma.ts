import { PrismaClient } from "@prisma/client";
import { applicationDatabaseUrl } from "@/src/lib/env/runtimeBaseline";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ datasourceUrl: applicationDatabaseUrl() });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
