ALTER TABLE "brands" ADD COLUMN "design_system" jsonb;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "design_status" text DEFAULT 'none' NOT NULL;