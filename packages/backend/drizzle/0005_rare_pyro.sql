ALTER TABLE "vaults" ADD COLUMN "primary_device_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vaults" ADD CONSTRAINT "vaults_primary_device_id_devices_id_fk" FOREIGN KEY ("primary_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
