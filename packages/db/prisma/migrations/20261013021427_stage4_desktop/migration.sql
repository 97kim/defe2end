-- CreateEnum
CREATE TYPE "RunLocation" AS ENUM ('server', 'desktop');

-- AlterTable
ALTER TABLE "Environment" ADD COLUMN     "useAuthSession" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "GroupRun" ADD COLUMN     "desktopDeviceId" TEXT,
ADD COLUMN     "location" "RunLocation" NOT NULL DEFAULT 'server';

-- AlterTable
ALTER TABLE "InstanceSetting" ADD COLUMN     "recorderTestAttributes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "desktopDeviceId" TEXT,
ADD COLUMN     "dispatchedAt" TIMESTAMP(3),
ADD COLUMN     "dispatchedConnectionId" TEXT,
ADD COLUMN     "location" "RunLocation" NOT NULL DEFAULT 'server';

-- CreateTable
CREATE TABLE "DesktopDevice" (
    "id" TEXT NOT NULL,
    "installId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "appVersion" TEXT,
    "runnerVersion" TEXT,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "connectionId" TEXT,
    "connectedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesktopDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesktopToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesktopToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "encryptedState" TEXT NOT NULL,
    "cookieCount" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DesktopDevice_userId_lastSeenAt_idx" ON "DesktopDevice"("userId", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "DesktopDevice_installId_userId_key" ON "DesktopDevice"("installId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "DesktopToken_tokenHash_key" ON "DesktopToken"("tokenHash");

-- CreateIndex
CREATE INDEX "DesktopToken_userId_idx" ON "DesktopToken"("userId");

-- CreateIndex
CREATE INDEX "DesktopToken_deviceId_idx" ON "DesktopToken"("deviceId");

-- CreateIndex
CREATE INDEX "AuthSession_workspaceId_idx" ON "AuthSession"("workspaceId");

-- CreateIndex
CREATE INDEX "AuthSession_userId_idx" ON "AuthSession"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_environmentId_userId_key" ON "AuthSession"("environmentId", "userId");

-- CreateIndex
CREATE INDEX "Run_desktopDeviceId_status_idx" ON "Run"("desktopDeviceId", "status");

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_desktopDeviceId_fkey" FOREIGN KEY ("desktopDeviceId") REFERENCES "DesktopDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupRun" ADD CONSTRAINT "GroupRun_desktopDeviceId_fkey" FOREIGN KEY ("desktopDeviceId") REFERENCES "DesktopDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopDevice" ADD CONSTRAINT "DesktopDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopToken" ADD CONSTRAINT "DesktopToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopToken" ADD CONSTRAINT "DesktopToken_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "DesktopDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
