import { tmpdir } from "node:os";

// Runs in every test file before any app code is imported.
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-0000";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.DEFE2END_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
// Run artifacts go to a throwaway directory, never into the checkout.
process.env.STORAGE_DIR ??= `${tmpdir()}/defe2end-web-test-storage`;
