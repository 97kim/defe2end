-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "testOfScenarioId" TEXT;

-- CreateIndex
CREATE INDEX "Run_testOfScenarioId_queuedAt_idx" ON "Run"("testOfScenarioId", "queuedAt");

