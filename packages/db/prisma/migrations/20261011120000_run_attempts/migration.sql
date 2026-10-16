-- AlterEnum
ALTER TYPE "StepResultStatus" ADD VALUE 'warning';

-- DropIndex
DROP INDEX "StepResult_runId_index_key";

-- AlterTable
ALTER TABLE "Artifact" ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "passedAfterRetry" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "warningCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Scenario" ADD COLUMN     "retryOnFailure" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "StepResult" ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE UNIQUE INDEX "StepResult_runId_attempt_index_key" ON "StepResult"("runId", "attempt", "index");


-- Runs that already started ran exactly one attempt.
UPDATE "Run" SET "attemptCount" = 1 WHERE "startedAt" IS NOT NULL;
