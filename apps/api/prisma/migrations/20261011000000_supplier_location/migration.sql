ALTER TABLE "Supplier" ADD COLUMN "city" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "Supplier" ADD COLUMN "longitude" DOUBLE PRECISION;

-- Demo hubs at different distances from Nairobi so the mile filter changes the catalogue.
UPDATE "Supplier" SET "city" = 'Kilimani', "latitude" = -1.2921, "longitude" = 36.787 WHERE "id" = 's-kijani';
UPDATE "Supplier" SET "city" = 'Westlands', "latitude" = -1.2674, "longitude" = 36.811 WHERE "id" = 's-atlas';
UPDATE "Supplier" SET "city" = 'Kitengela', "latitude" = -1.477, "longitude" = 36.96 WHERE "id" = 's-savanna';
UPDATE "Supplier" SET "city" = 'Nakuru', "latitude" = -0.3031, "longitude" = 36.08 WHERE "id" = 's-metals';
