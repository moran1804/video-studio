ALTER TABLE "references" ADD COLUMN "usage" text DEFAULT 'inspiration' NOT NULL;--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "animate_asset_id" uuid;