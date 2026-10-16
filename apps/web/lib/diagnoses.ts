// Stage 6 contract section 8: AI diagnoses of a failed run, kept apart from the step errors (never appended to them).
// Saving and reading both need `run.read` (section 9) — a viewer may ask for a diagnosis of what they can see.
import { z } from "zod";
import { ApiError } from "./api";
import { getDb } from "./db";

export const DIAGNOSIS_TEXT_MAX = 20_000;

export const createDiagnosisSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  text: z.string().trim().min(1).max(DIAGNOSIS_TEXT_MAX),
});

export interface DiagnosisView {
  id: string;
  provider: string;
  text: string;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
}

async function requireRun(workspaceId: string, runId: string): Promise<void> {
  const run = await getDb().run.findFirst({ where: { id: runId, workspaceId }, select: { id: true } });
  if (!run) throw ApiError.notFound();
}

const toView = (d: { id: string; provider: string; text: string; createdAt: Date; createdBy: { id: string; name: string } | null }): DiagnosisView => ({
  id: d.id,
  provider: d.provider,
  text: d.text,
  createdAt: d.createdAt.toISOString(),
  createdBy: d.createdBy,
});

export async function listDiagnoses(workspaceId: string, runId: string): Promise<DiagnosisView[]> {
  await requireRun(workspaceId, runId);
  const rows = await getDb().runDiagnosis.findMany({
    where: { runId },
    orderBy: { createdAt: "desc" },
    take: 20,
    include: { createdBy: { select: { id: true, name: true } } },
  });
  return rows.map(toView);
}

export async function createDiagnosis(workspaceId: string, runId: string, userId: string, input: z.infer<typeof createDiagnosisSchema>): Promise<DiagnosisView> {
  await requireRun(workspaceId, runId);
  const row = await getDb().runDiagnosis.create({
    data: { runId, provider: input.provider, text: input.text, createdById: userId },
    include: { createdBy: { select: { id: true, name: true } } },
  });
  return toView(row);
}
