import type { PrismaConfig } from "prisma/config";

// A plain object (no runtime import): in the migrate image the Prisma CLI sits outside this package's own deps.
export default {
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "" },
} satisfies PrismaConfig;
