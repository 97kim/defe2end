-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_webhookId_runId_key" ON "NotificationDelivery"("webhookId", "runId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_webhookId_groupRunId_key" ON "NotificationDelivery"("webhookId", "groupRunId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_webhookId_scheduleFireId_key" ON "NotificationDelivery"("webhookId", "scheduleFireId");

