-- Each turn counts its executions: its authenticator raises the number each
-- time the turn starts or resumes, and the bot loop's writes for an older
-- execution are refused. A turn has had none until the next time it starts.
ALTER TABLE "turn" ADD COLUMN "execution_number" integer DEFAULT 0 NOT NULL;
