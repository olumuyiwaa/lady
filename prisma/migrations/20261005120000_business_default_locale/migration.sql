-- Storefront default language per business.
-- Existing businesses default to Dutch (the platform's market); owners can switch to "en" in settings.

-- AlterTable
ALTER TABLE "Business" ADD COLUMN "defaultLocale" TEXT NOT NULL DEFAULT 'nl';
