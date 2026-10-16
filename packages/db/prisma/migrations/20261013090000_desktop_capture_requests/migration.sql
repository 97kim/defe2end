-- CreateTable
CREATE TABLE "DesktopCaptureRequest" (
    "deviceId" TEXT NOT NULL,
    "message" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesktopCaptureRequest_pkey" PRIMARY KEY ("deviceId")
);

-- AddForeignKey
ALTER TABLE "DesktopCaptureRequest" ADD CONSTRAINT "DesktopCaptureRequest_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "DesktopDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
