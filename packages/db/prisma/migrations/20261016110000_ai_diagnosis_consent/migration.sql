-- Stage 6 contract section 8: the AI failure diagnosis consent, kept per user on the server.
ALTER TABLE "user" ADD COLUMN "aiDiagnosisConsentAt" TIMESTAMP(3);
