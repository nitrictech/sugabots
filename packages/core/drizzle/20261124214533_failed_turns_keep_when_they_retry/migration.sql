-- When a failed turn that runs again may run, as its model's provider asked, kept
-- with the failure so a workflow resuming after it still waits. Existing turns
-- keep none: their workflows wait the usual delay.
ALTER TABLE "turn" ADD COLUMN "retry_at" timestamp with time zone;
