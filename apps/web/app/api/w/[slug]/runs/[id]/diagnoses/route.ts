import { route } from "../../../../../../../lib/api";
import { createDiagnosis, createDiagnosisSchema, listDiagnoses } from "../../../../../../../lib/diagnoses";

export const dynamic = "force-dynamic";

export const GET = route<{ slug: string; id: string }>({ action: "run.read", resource: "run" }, async ({ params, workspace }) => {
  return Response.json({ diagnoses: await listDiagnoses(workspace.id, params.id) });
});

export const POST = route<{ slug: string; id: string }>({ action: "run.read", resource: "run" }, async ({ request, params, workspace, actor }) => {
  const input = createDiagnosisSchema.parse(await request.json().catch(() => ({})));
  return Response.json(await createDiagnosis(workspace.id, params.id, actor.user.id, input), { status: 201 });
});
