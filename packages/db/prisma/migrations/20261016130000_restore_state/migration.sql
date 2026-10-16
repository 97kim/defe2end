-- AlterTable
ALTER TABLE "InstanceSetting" ADD COLUMN     "automationPausedAt" TIMESTAMP(3),
ADD COLUMN     "restoreInProgressAt" TIMESTAMP(3);
