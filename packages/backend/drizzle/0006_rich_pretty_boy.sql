ALTER TABLE "users" ALTER COLUMN "device_limit" SET DEFAULT 7;--> statement-breakpoint
-- Only rows still at the old default - never touches anyone whose limit
-- was deliberately raised/customized already.
UPDATE "users" SET "device_limit" = 7 WHERE "device_limit" = 10;