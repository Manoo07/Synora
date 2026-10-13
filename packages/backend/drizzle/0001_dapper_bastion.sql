ALTER TABLE "users" ADD COLUMN "plan" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "storage_limit_bytes" bigint DEFAULT 262144000 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "storage_bytes_used" bigint DEFAULT 0 NOT NULL;