-- What each model request used and cost is in `model_request` now; a turn keeps only its context measurement.
ALTER TABLE "turn" DROP COLUMN "usage";--> statement-breakpoint
ALTER TABLE "turn" DROP COLUMN "reported_cost";--> statement-breakpoint

-- A turn waiting on approvals keeps how many model calls it has made, which limits the steps it has left once it resumes. Its checkpoint had that count inside `usage`; move it to where it is read now, and drop the rest.
UPDATE "turn"
SET "checkpoint" = jsonb_set(
	"checkpoint",
	'{accounting}',
	("checkpoint" -> 'accounting') - 'usage' - 'reportedCost'
		|| jsonb_strip_nulls(jsonb_build_object('modelCalls', "checkpoint" -> 'accounting' -> 'usage' -> 'modelCalls'))
)
WHERE "checkpoint" -> 'accounting' ? 'usage';
