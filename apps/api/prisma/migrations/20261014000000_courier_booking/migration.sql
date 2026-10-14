CREATE TABLE "CourierBooking" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "courierName" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'booked',
    "dropoffCity" TEXT,
    "dropoffAddress" TEXT,
    "bookedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourierBooking_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourierBooking_orderItemId_key" ON "CourierBooking"("orderItemId");

CREATE UNIQUE INDEX "CourierBooking_reference_key" ON "CourierBooking"("reference");

CREATE INDEX "CourierBooking_status_idx" ON "CourierBooking"("status");

ALTER TABLE "CourierBooking" ADD CONSTRAINT "CourierBooking_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
