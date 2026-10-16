import { workerDatabaseUrl } from "./database-url.js";

// Runs in every test file before any worker code is imported.
const url = workerDatabaseUrl();
if (url) process.env.DATABASE_URL = url;
process.env.DEFE2END_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
