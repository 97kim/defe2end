import { route } from "../../../../lib/api";
import { getDb } from "../../../../lib/db";

export const dynamic = "force-dynamic";

// The caller's own AI failure diagnosis consent (stage 6 contract section 8): asked once per user, not per device.
const spec = { action: "account.write", resource: "instance" } as const;

function body(at: Date | null): Response {
  return Response.json({ consentedAt: at?.toISOString() ?? null });
}

export const GET = route(spec, async ({ actor }) => {
  const user = await getDb().user.findUnique({ where: { id: actor.userId }, select: { aiDiagnosisConsentAt: true } });
  return body(user?.aiDiagnosisConsentAt ?? null);
});

/** Records the consent; an earlier one keeps its time. */
export const POST = route(spec, async ({ actor }) => {
  const db = getDb();
  await db.user.updateMany({ where: { id: actor.userId, aiDiagnosisConsentAt: null }, data: { aiDiagnosisConsentAt: new Date() } });
  const user = await db.user.findUnique({ where: { id: actor.userId }, select: { aiDiagnosisConsentAt: true } });
  return body(user?.aiDiagnosisConsentAt ?? null);
});

/** Withdraws it; the next diagnosis asks again. */
export const DELETE = route(spec, async ({ actor }) => {
  await getDb().user.update({ where: { id: actor.userId }, data: { aiDiagnosisConsentAt: null } });
  return body(null);
});
