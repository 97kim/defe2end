-- CreateEnum
CREATE TYPE "VisualVerdict" AS ENUM ('created', 'match', 'shifted', 'changed', 'size_mismatch', 'skipped', 'incomparable');

-- CreateEnum
CREATE TYPE "BaselineSource" AS ENUM ('auto', 'approved');

-- CreateEnum
CREATE TYPE "ComparisonSide" AS ENUM ('left', 'right');

-- CreateEnum
CREATE TYPE "EnvComparisonStatus" AS ENUM ('running', 'comparing', 'done', 'error', 'cancelled');

-- CreateEnum
CREATE TYPE "ComparisonVerdict" AS ENUM ('same', 'different', 'incomparable');

-- CreateEnum
CREATE TYPE "EnvComparisonFileKind" AS ENUM ('screen_diff', 'structure_diff');

-- AlterEnum


ALTER TYPE "ArtifactKind" ADD VALUE 'visual_diff';
ALTER TYPE "ArtifactKind" ADD VALUE 'a11y_snapshot';

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "comparisonId" TEXT,
ADD COLUMN     "comparisonSide" "ComparisonSide";

-- AlterTable
ALTER TABLE "Scenario" ADD COLUMN     "maskingEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "maskSelectors" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "StepResult" ADD COLUMN     "render" JSONB,
ADD COLUMN     "visualBaselineVersionId" TEXT,
ADD COLUMN     "visualDiffPercent" DOUBLE PRECISION,
ADD COLUMN     "visualServerVerdict" "VisualVerdict",
ADD COLUMN     "visualShift" JSONB,
ADD COLUMN     "visualShiftDiffPercent" DOUBLE PRECISION,
ADD COLUMN     "visualVerdict" "VisualVerdict";

-- CreateTable
CREATE TABLE "VisualBaseline" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "runtime" TEXT NOT NULL,
    "currentVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisualBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisualBaselineVersion" (
    "id" TEXT NOT NULL,
    "baselineId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "render" JSONB NOT NULL,
    "source" "BaselineSource" NOT NULL,
    "approvedById" TEXT,
    "sourceRunId" TEXT,
    "sourceStepResultId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisualBaselineVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunBaselinePin" (
    "runId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,

    CONSTRAINT "RunBaselinePin_pkey" PRIMARY KEY ("runId","versionId")
);

-- CreateTable
CREATE TABLE "EnvComparison" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "leftEnvironmentId" TEXT NOT NULL,
    "rightEnvironmentId" TEXT NOT NULL,
    "leftBaseUrl" TEXT NOT NULL,
    "rightBaseUrl" TEXT NOT NULL,
    "location" "RunLocation" NOT NULL,
    "deviceId" TEXT,
    "conditions" JSONB NOT NULL,
    "status" "EnvComparisonStatus" NOT NULL DEFAULT 'running',
    "round" INTEGER NOT NULL DEFAULT 1,
    "claimToken" TEXT,
    "claimExpiresAt" TIMESTAMP(3),
    "tolerance" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "screenVerdict" "ComparisonVerdict",
    "structureVerdict" "ComparisonVerdict",
    "error" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "EnvComparison_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvComparisonStep" (
    "id" TEXT NOT NULL,
    "comparisonId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "leftStepResultId" TEXT,
    "rightStepResultId" TEXT,
    "screenVerdict" "ComparisonVerdict",
    "screenDiffPercent" DOUBLE PRECISION,
    "screenShiftDiffPercent" DOUBLE PRECISION,
    "screenShift" JSONB,
    "screenTolerance" DOUBLE PRECISION,
    "screenDiffKey" TEXT,
    "structureVerdict" "ComparisonVerdict",
    "structureMoved" INTEGER,
    "structureAdded" INTEGER,
    "structureRemoved" INTEGER,
    "structureChanged" INTEGER,
    "structureDiffKey" TEXT,
    "reason" TEXT,

    CONSTRAINT "EnvComparisonStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvComparisonFile" (
    "id" TEXT NOT NULL,
    "comparisonId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "claimToken" TEXT NOT NULL,
    "kind" "EnvComparisonFileKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnvComparisonFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VisualBaseline_workspaceId_idx" ON "VisualBaseline"("workspaceId");

-- CreateIndex
CREATE INDEX "VisualBaseline_environmentId_idx" ON "VisualBaseline"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "VisualBaseline_scenarioId_stepId_environmentId_device_runti_key" ON "VisualBaseline"("scenarioId", "stepId", "environmentId", "device", "runtime");

-- CreateIndex
CREATE UNIQUE INDEX "VisualBaselineVersion_storageKey_key" ON "VisualBaselineVersion"("storageKey");

-- CreateIndex
CREATE INDEX "VisualBaselineVersion_sourceRunId_idx" ON "VisualBaselineVersion"("sourceRunId");

-- CreateIndex
CREATE INDEX "VisualBaselineVersion_sourceStepResultId_idx" ON "VisualBaselineVersion"("sourceStepResultId");

-- CreateIndex
CREATE INDEX "VisualBaselineVersion_approvedById_idx" ON "VisualBaselineVersion"("approvedById");

-- CreateIndex
CREATE UNIQUE INDEX "VisualBaselineVersion_baselineId_version_key" ON "VisualBaselineVersion"("baselineId", "version");

-- CreateIndex
CREATE INDEX "RunBaselinePin_versionId_idx" ON "RunBaselinePin"("versionId");

-- CreateIndex
CREATE INDEX "EnvComparison_workspaceId_createdAt_idx" ON "EnvComparison"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "EnvComparison_scenarioId_idx" ON "EnvComparison"("scenarioId");

-- CreateIndex
CREATE INDEX "EnvComparison_siteId_idx" ON "EnvComparison"("siteId");

-- CreateIndex
CREATE INDEX "EnvComparison_leftEnvironmentId_idx" ON "EnvComparison"("leftEnvironmentId");

-- CreateIndex
CREATE INDEX "EnvComparison_rightEnvironmentId_idx" ON "EnvComparison"("rightEnvironmentId");

-- CreateIndex
CREATE INDEX "EnvComparison_status_claimExpiresAt_idx" ON "EnvComparison"("status", "claimExpiresAt");

-- CreateIndex
CREATE INDEX "EnvComparisonStep_leftStepResultId_idx" ON "EnvComparisonStep"("leftStepResultId");

-- CreateIndex
CREATE INDEX "EnvComparisonStep_rightStepResultId_idx" ON "EnvComparisonStep"("rightStepResultId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvComparisonStep_comparisonId_stepId_round_key" ON "EnvComparisonStep"("comparisonId", "stepId", "round");

-- CreateIndex
CREATE UNIQUE INDEX "EnvComparisonFile_storageKey_key" ON "EnvComparisonFile"("storageKey");

-- CreateIndex
CREATE INDEX "EnvComparisonFile_comparisonId_round_idx" ON "EnvComparisonFile"("comparisonId", "round");

-- CreateIndex
CREATE INDEX "Run_comparisonId_idx" ON "Run"("comparisonId");

-- CreateIndex
CREATE INDEX "StepResult_visualBaselineVersionId_idx" ON "StepResult"("visualBaselineVersionId");

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_comparisonId_fkey" FOREIGN KEY ("comparisonId") REFERENCES "EnvComparison"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepResult" ADD CONSTRAINT "StepResult_visualBaselineVersionId_fkey" FOREIGN KEY ("visualBaselineVersionId") REFERENCES "VisualBaselineVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualBaseline" ADD CONSTRAINT "VisualBaseline_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualBaseline" ADD CONSTRAINT "VisualBaseline_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualBaseline" ADD CONSTRAINT "VisualBaseline_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualBaselineVersion" ADD CONSTRAINT "VisualBaselineVersion_baselineId_fkey" FOREIGN KEY ("baselineId") REFERENCES "VisualBaseline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualBaselineVersion" ADD CONSTRAINT "VisualBaselineVersion_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualBaselineVersion" ADD CONSTRAINT "VisualBaselineVersion_sourceRunId_fkey" FOREIGN KEY ("sourceRunId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualBaselineVersion" ADD CONSTRAINT "VisualBaselineVersion_sourceStepResultId_fkey" FOREIGN KEY ("sourceStepResultId") REFERENCES "StepResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunBaselinePin" ADD CONSTRAINT "RunBaselinePin_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunBaselinePin" ADD CONSTRAINT "RunBaselinePin_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "VisualBaselineVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvComparison" ADD CONSTRAINT "EnvComparison_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvComparison" ADD CONSTRAINT "EnvComparison_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvComparison" ADD CONSTRAINT "EnvComparison_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvComparison" ADD CONSTRAINT "EnvComparison_leftEnvironmentId_fkey" FOREIGN KEY ("leftEnvironmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvComparison" ADD CONSTRAINT "EnvComparison_rightEnvironmentId_fkey" FOREIGN KEY ("rightEnvironmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvComparison" ADD CONSTRAINT "EnvComparison_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "DesktopDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvComparison" ADD CONSTRAINT "EnvComparison_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvComparisonStep" ADD CONSTRAINT "EnvComparisonStep_comparisonId_fkey" FOREIGN KEY ("comparisonId") REFERENCES "EnvComparison"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvComparisonStep" ADD CONSTRAINT "EnvComparisonStep_leftStepResultId_fkey" FOREIGN KEY ("leftStepResultId") REFERENCES "StepResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvComparisonStep" ADD CONSTRAINT "EnvComparisonStep_rightStepResultId_fkey" FOREIGN KEY ("rightStepResultId") REFERENCES "StepResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvComparisonFile" ADD CONSTRAINT "EnvComparisonFile_comparisonId_fkey" FOREIGN KEY ("comparisonId") REFERENCES "EnvComparison"("id") ON DELETE CASCADE ON UPDATE CASCADE;

