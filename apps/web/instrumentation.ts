export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ runStartup }, { getDb }] = await Promise.all([import("./lib/startup"), import("./lib/db")]);
  await runStartup(getDb());
}
