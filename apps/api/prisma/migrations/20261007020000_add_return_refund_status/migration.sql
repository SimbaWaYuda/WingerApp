-- CreateEnum
CREATE TYPE "ReturnRefundStatus" AS ENUM ('NONE', 'PENDING', 'ISSUED', 'NOT_REQUIRED');

-- AlterTable
ALTER TABLE "ReturnRequest" ADD COLUMN "refundStatus" "ReturnRefundStatus" NOT NULL DEFAULT 'NONE';
ALTER TABLE "ReturnRequest" ADD COLUMN "refundNote" TEXT;
ALTER TABLE "ReturnRequest" ADD COLUMN "refundedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ReturnRequest_refundStatus_idx" ON "ReturnRequest"("refundStatus");

-- Approved returns that are still open for finance start as PENDING.
UPDATE "ReturnRequest"
SET "refundStatus" = 'PENDING'
WHERE "status" = 'APPROVED';

-- Rejected / closed returns do not need a refund by default.
UPDATE "ReturnRequest"
SET "refundStatus" = 'NOT_REQUIRED'
WHERE "status" IN ('REJECTED', 'CLOSED') AND "refundStatus" = 'NONE';
