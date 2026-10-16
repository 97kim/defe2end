import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import { APP_CONNECTION_NAME } from "./instance-state.js";

export * from "./generated/prisma/client.js";

export function createDbClient(databaseUrl = process.env.DATABASE_URL): PrismaClient {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, application_name: APP_CONNECTION_NAME }) });
}
export * from "./instance-state.js";
export * from "./runs.js";
export * from "./groups.js";
export * from "./maintenance.js";
export * from "./baseline-cleanup.js";
export * from "./visual-baselines.js";
export * from "./locks.js";
export * from "./desktop.js";
export * from "./variables.js";
export * from "./notifications.js";
export * from "./notify-send.js";
export * from "./notify-message.js";
export * from "./schedules.js";
export * from "./run-create.js";
export * from "./env-comparison.js";
