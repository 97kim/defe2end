-- CreateEnum
CREATE TYPE "ScheduleOverlap" AS ENUM ('skip', 'allow');

-- CreateEnum
CREATE TYPE "ScheduleFireStatus" AS ENUM ('started', 'skipped_overlap', 'missed', 'refused', 'error');

-- CreateEnum
CREATE TYPE "NotifyOn" AS ENUM ('failures', 'all', 'changes');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('run', 'group', 'scheduleFire', 'report', 'test');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('pending', 'sending', 'sent', 'failed', 'dead');

-- AlterTable
ALTER TABLE "AuthSession" ADD COLUMN     "botTokenId" TEXT,
ADD COLUMN     "scheduleId" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "GroupRun" ADD COLUMN     "botTokenId" TEXT,
ADD COLUMN     "scheduleId" TEXT;

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "botTokenId" TEXT,
ADD COLUMN     "scheduleId" TEXT;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC';

-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "scenarioIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tagId" TEXT,
    "mode" "GroupRunMode" NOT NULL DEFAULT 'sequential',
    "continueOnFailure" BOOLEAN NOT NULL DEFAULT true,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "overlap" "ScheduleOverlap" NOT NULL DEFAULT 'skip',
    "nextRunAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleVariableValue" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "variableId" TEXT NOT NULL,
    "value" TEXT,
    "valueEncrypted" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleVariableValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleFire" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" "ScheduleFireStatus" NOT NULL,
    "missedUntil" TIMESTAMP(3),
    "missedCount" INTEGER,
    "groupRunId" TEXT,
    "reasonCode" TEXT,
    "scheduleVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleFire_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotToken" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotVariableValue" (
    "id" TEXT NOT NULL,
    "botTokenId" TEXT NOT NULL,
    "variableId" TEXT NOT NULL,
    "value" TEXT,
    "valueEncrypted" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotVariableValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiIdempotency" (
    "id" TEXT NOT NULL,
    "botTokenId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "runId" TEXT,
    "groupRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiIdempotency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlackWebhook" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "urlEncrypted" TEXT NOT NULL,
    "urlHint" TEXT NOT NULL,
    "notifyOn" "NotifyOn" NOT NULL DEFAULT 'failures',
    "sources" "RunTrigger"[] DEFAULT ARRAY['schedule', 'api']::"RunTrigger"[],
    "dailyReport" BOOLEAN NOT NULL DEFAULT false,
    "reportTime" TEXT NOT NULL DEFAULT '09:00',
    "reportTimezone" TEXT NOT NULL DEFAULT 'UTC',
    "invalidAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlackWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportWindow" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "from" TIMESTAMP(3) NOT NULL,
    "to" TIMESTAMP(3) NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "runId" TEXT,
    "groupRunId" TEXT,
    "scheduleFireId" TEXT,
    "payload" JSONB NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationAttempt" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMs" INTEGER,
    "statusCode" INTEGER,
    "errorCode" TEXT,

    CONSTRAINT "NotificationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Schedule_workspaceId_idx" ON "Schedule"("workspaceId");

-- CreateIndex
CREATE INDEX "Schedule_enabled_nextRunAt_idx" ON "Schedule"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "ScheduleVariableValue_variableId_idx" ON "ScheduleVariableValue"("variableId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleVariableValue_scheduleId_variableId_key" ON "ScheduleVariableValue"("scheduleId", "variableId");

-- CreateIndex
CREATE INDEX "ScheduleFire_scheduleId_createdAt_idx" ON "ScheduleFire"("scheduleId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleFire_scheduleId_scheduledFor_key" ON "ScheduleFire"("scheduleId", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "BotToken_tokenHash_key" ON "BotToken"("tokenHash");

-- CreateIndex
CREATE INDEX "BotToken_workspaceId_idx" ON "BotToken"("workspaceId");

-- CreateIndex
CREATE INDEX "BotVariableValue_variableId_idx" ON "BotVariableValue"("variableId");

-- CreateIndex
CREATE UNIQUE INDEX "BotVariableValue_botTokenId_variableId_key" ON "BotVariableValue"("botTokenId", "variableId");

-- CreateIndex
CREATE INDEX "ApiIdempotency_createdAt_idx" ON "ApiIdempotency"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiIdempotency_botTokenId_key_key" ON "ApiIdempotency"("botTokenId", "key");

-- CreateIndex
CREATE INDEX "SlackWebhook_workspaceId_idx" ON "SlackWebhook"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportWindow_deliveryId_key" ON "ReportWindow"("deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportWindow_webhookId_to_key" ON "ReportWindow"("webhookId", "to");

-- CreateIndex
CREATE INDEX "NotificationDelivery_status_nextAttemptAt_idx" ON "NotificationDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_webhookId_createdAt_idx" ON "NotificationDelivery"("webhookId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationAttempt_deliveryId_attempt_key" ON "NotificationAttempt"("deliveryId", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_environmentId_scheduleId_key" ON "AuthSession"("environmentId", "scheduleId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_environmentId_botTokenId_key" ON "AuthSession"("environmentId", "botTokenId");

-- CreateIndex
CREATE INDEX "GroupRun_scheduleId_status_idx" ON "GroupRun"("scheduleId", "status");

-- CreateIndex
CREATE INDEX "Run_scheduleId_status_idx" ON "Run"("scheduleId", "status");

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_botTokenId_fkey" FOREIGN KEY ("botTokenId") REFERENCES "BotToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupRun" ADD CONSTRAINT "GroupRun_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupRun" ADD CONSTRAINT "GroupRun_botTokenId_fkey" FOREIGN KEY ("botTokenId") REFERENCES "BotToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_botTokenId_fkey" FOREIGN KEY ("botTokenId") REFERENCES "BotToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleVariableValue" ADD CONSTRAINT "ScheduleVariableValue_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleVariableValue" ADD CONSTRAINT "ScheduleVariableValue_variableId_fkey" FOREIGN KEY ("variableId") REFERENCES "Variable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleFire" ADD CONSTRAINT "ScheduleFire_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleFire" ADD CONSTRAINT "ScheduleFire_groupRunId_fkey" FOREIGN KEY ("groupRunId") REFERENCES "GroupRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotToken" ADD CONSTRAINT "BotToken_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotToken" ADD CONSTRAINT "BotToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotVariableValue" ADD CONSTRAINT "BotVariableValue_botTokenId_fkey" FOREIGN KEY ("botTokenId") REFERENCES "BotToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotVariableValue" ADD CONSTRAINT "BotVariableValue_variableId_fkey" FOREIGN KEY ("variableId") REFERENCES "Variable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiIdempotency" ADD CONSTRAINT "ApiIdempotency_botTokenId_fkey" FOREIGN KEY ("botTokenId") REFERENCES "BotToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiIdempotency" ADD CONSTRAINT "ApiIdempotency_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiIdempotency" ADD CONSTRAINT "ApiIdempotency_groupRunId_fkey" FOREIGN KEY ("groupRunId") REFERENCES "GroupRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlackWebhook" ADD CONSTRAINT "SlackWebhook_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlackWebhook" ADD CONSTRAINT "SlackWebhook_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportWindow" ADD CONSTRAINT "ReportWindow_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "SlackWebhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportWindow" ADD CONSTRAINT "ReportWindow_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "NotificationDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "SlackWebhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_groupRunId_fkey" FOREIGN KEY ("groupRunId") REFERENCES "GroupRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_scheduleFireId_fkey" FOREIGN KEY ("scheduleFireId") REFERENCES "ScheduleFire"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationAttempt" ADD CONSTRAINT "NotificationAttempt_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "NotificationDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written constraints Prisma can't express (stage 5 contract section 2).
-- A login session belongs to exactly one owner: a person, a schedule or a bot token.
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_one_owner" CHECK (num_nonnulls("userId", "scheduleId", "botTokenId") = 1);
-- A schedule targets listed scenarios or a tag, never both. Neither is allowed: deleting its tag sets tagId
-- to null, and the schedule then fires as refused(no_scenarios) until it is edited.
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_one_target" CHECK ("tagId" IS NULL OR cardinality("scenarioIds") = 0);
-- A missed stretch carries its end and count; other fires don't.
ALTER TABLE "ScheduleFire" ADD CONSTRAINT "ScheduleFire_missed_stretch" CHECK ((status = 'missed') = ("missedUntil" IS NOT NULL AND "missedCount" IS NOT NULL));
