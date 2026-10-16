-- CreateEnum
CREATE TYPE "VariableScope" AS ENUM ('shared', 'personal');

-- AlterTable
ALTER TABLE "Variable" ADD COLUMN     "scope" "VariableScope" NOT NULL DEFAULT 'shared';

-- CreateTable
CREATE TABLE "PersonalVariableValue" (
    "id" TEXT NOT NULL,
    "variableId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "value" TEXT,
    "valueEncrypted" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonalVariableValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PersonalVariableValue_userId_idx" ON "PersonalVariableValue"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PersonalVariableValue_variableId_userId_key" ON "PersonalVariableValue"("variableId", "userId");

-- AddForeignKey
ALTER TABLE "PersonalVariableValue" ADD CONSTRAINT "PersonalVariableValue_variableId_fkey" FOREIGN KEY ("variableId") REFERENCES "Variable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalVariableValue" ADD CONSTRAINT "PersonalVariableValue_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

