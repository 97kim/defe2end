-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('queued', 'running', 'passed', 'failed', 'error', 'cancelled', 'timed_out');

-- CreateEnum
CREATE TYPE "RunTrigger" AS ENUM ('manual', 'test', 'schedule', 'api');

-- CreateEnum
CREATE TYPE "StepResultStatus" AS ENUM ('passed', 'failed', 'error', 'cancelled', 'timed_out', 'skipped');

-- CreateEnum
CREATE TYPE "ArtifactKind" AS ENUM ('screenshot', 'video', 'trace', 'log');

-- CreateEnum
CREATE TYPE "GroupRunMode" AS ENUM ('sequential', 'parallel');

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scenarioId" TEXT,
    "environmentId" TEXT,
    "groupRunId" TEXT,
    "groupIndex" INTEGER,
    "trigger" "RunTrigger" NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "requestedById" TEXT,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "snapshot" JSONB NOT NULL,
    "options" JSONB NOT NULL DEFAULT '{}',
    "runnerVersion" TEXT,
    "browserVersion" TEXT,
    "workerId" TEXT,
    "claimToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "variablesResolvedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StepResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "stepId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" "StepResultStatus" NOT NULL,
    "attempts" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "expected" TEXT,
    "actual" TEXT,
    "possibleDuplicate" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "StepResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "ArtifactKind" NOT NULL,
    "stepIndex" INTEGER,
    "name" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "environmentId" TEXT,
    "mode" "GroupRunMode" NOT NULL,
    "continueOnFailure" BOOLEAN NOT NULL,
    "requestedById" TEXT,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "GroupRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Run_status_queuedAt_idx" ON "Run"("status", "queuedAt");

-- CreateIndex
CREATE INDEX "Run_workspaceId_status_idx" ON "Run"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Run_workspaceId_queuedAt_idx" ON "Run"("workspaceId", "queuedAt");

-- CreateIndex
CREATE INDEX "Run_scenarioId_queuedAt_idx" ON "Run"("scenarioId", "queuedAt");

-- CreateIndex
CREATE INDEX "Run_groupRunId_groupIndex_idx" ON "Run"("groupRunId", "groupIndex");

-- CreateIndex
CREATE UNIQUE INDEX "Run_workspaceId_idempotencyKey_key" ON "Run"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "StepResult_runId_index_key" ON "StepResult"("runId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "Artifact_storageKey_key" ON "Artifact"("storageKey");

-- CreateIndex
CREATE INDEX "Artifact_runId_idx" ON "Artifact"("runId");

-- CreateIndex
CREATE INDEX "GroupRun_workspaceId_createdAt_idx" ON "GroupRun"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_storageKey_key" ON "Attachment"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_workspaceId_name_version_key" ON "Attachment"("workspaceId", "name", "version");

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_groupRunId_fkey" FOREIGN KEY ("groupRunId") REFERENCES "GroupRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepResult" ADD CONSTRAINT "StepResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupRun" ADD CONSTRAINT "GroupRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupRun" ADD CONSTRAINT "GroupRun_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupRun" ADD CONSTRAINT "GroupRun_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
