-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "businessBio" TEXT,
ADD COLUMN     "deliveryConfigured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "deliveryNotes" TEXT,
ADD COLUMN     "payoutSetupComplete" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "city" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "preferredLocale" TEXT,
ADD COLUMN     "profileComplete" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "OnboardingProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "completedKeys" JSONB NOT NULL DEFAULT '[]',
    "skippedKeys" JSONB NOT NULL DEFAULT '[]',
    "activityFlags" JSONB NOT NULL DEFAULT '{}',
    "checklistDismissed" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Nairobi',
    "setupComplete" BOOLEAN NOT NULL DEFAULT false,
    "permissionsSeeded" BOOLEAN NOT NULL DEFAULT false,
    "deliveryConfigured" BOOLEAN NOT NULL DEFAULT false,
    "paymentsConfigured" BOOLEAN NOT NULL DEFAULT false,
    "commissionsConfigured" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingProgress_userId_key" ON "OnboardingProgress"("userId");

-- AddForeignKey
ALTER TABLE "OnboardingProgress" ADD CONSTRAINT "OnboardingProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
