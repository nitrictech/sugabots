ALTER TABLE "agent" ADD COLUMN "color" text;--> statement-breakpoint
-- `hue` was an oklch hue. Each range goes to the named colour whose face hue is nearest.
UPDATE "agent" SET "color" = CASE
	WHEN "hue" % 360 < 32 OR "hue" % 360 >= 332 THEN 'rose'
	WHEN "hue" % 360 < 67 THEN 'orange'
	WHEN "hue" % 360 < 118 THEN 'yellow'
	WHEN "hue" % 360 < 166 THEN 'green'
	WHEN "hue" % 360 < 210 THEN 'teal'
	WHEN "hue" % 360 < 270 THEN 'sky'
	ELSE 'purple'
END;--> statement-breakpoint
ALTER TABLE "agent" ALTER COLUMN "color" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" DROP COLUMN "hue";--> statement-breakpoint
-- The eye styles took the design's names.
UPDATE "agent" SET "face" = CASE "face"
	WHEN 'bar' THEN 'pill'
	WHEN 'smile' THEN 'arc'
	WHEN 'dots' THEN 'dot'
	ELSE "face"
END;
