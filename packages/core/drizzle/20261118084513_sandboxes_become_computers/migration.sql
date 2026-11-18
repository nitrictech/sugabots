ALTER TABLE "sandbox_agent_allowed_host" RENAME TO "agent_allowed_host";--> statement-breakpoint
ALTER TABLE "sandbox_allowed_host" RENAME TO "allowed_host";--> statement-breakpoint
ALTER TABLE "sandbox_blocked_host" RENAME TO "blocked_host";--> statement-breakpoint
ALTER TABLE "sandbox" RENAME TO "computer";--> statement-breakpoint
ALTER TABLE "sandbox_lease" RENAME TO "computer_lease";--> statement-breakpoint
ALTER TABLE "sandbox_provider" RENAME TO "computer_provider";--> statement-breakpoint
ALTER TABLE "computer" RENAME COLUMN "sandbox_provider_id" TO "computer_provider_id";--> statement-breakpoint
ALTER TABLE "computer" RENAME COLUMN "provider_sandbox_id" TO "provider_computer_id";--> statement-breakpoint
ALTER TABLE "computer_lease" RENAME COLUMN "sandbox_id" TO "computer_id";--> statement-breakpoint
ALTER TABLE "agent" RENAME COLUMN "uses_sandbox" TO "uses_computer";--> statement-breakpoint
ALTER TABLE "computer" RENAME CONSTRAINT "sandbox_disk_measured_check" TO "computer_disk_measured_check";--> statement-breakpoint
ALTER TABLE "computer_lease" RENAME CONSTRAINT "sandbox_lease_holder_kind_check" TO "computer_lease_holder_kind_check";--> statement-breakpoint
ALTER TABLE "computer_provider" RENAME CONSTRAINT "sandbox_provider_preset_check" TO "computer_provider_preset_check";--> statement-breakpoint
ALTER INDEX "sandbox_agent_id_idx" RENAME TO "computer_agent_id_idx";--> statement-breakpoint
ALTER INDEX "sandbox_provider_enabled_idx" RENAME TO "computer_provider_enabled_idx";--> statement-breakpoint
ALTER INDEX "sandbox_provider_id_workspace_id_idx" RENAME TO "computer_provider_id_workspace_id_idx";--> statement-breakpoint
ALTER TABLE "agent_allowed_host" RENAME CONSTRAINT "sandbox_agent_allowed_host_agent_workspace_fkey" TO "agent_allowed_host_agent_workspace_fkey";--> statement-breakpoint
ALTER TABLE "computer" RENAME CONSTRAINT "sandbox_agent_workspace_fkey" TO "computer_agent_workspace_fkey";--> statement-breakpoint
ALTER TABLE "computer" RENAME CONSTRAINT "sandbox_provider_workspace_fkey" TO "computer_provider_workspace_fkey";--> statement-breakpoint
-- Constraints Postgres named itself (primary keys, not-null constraints and the
-- foreign keys named for their columns) keep the old words in their names;
-- the ones a server has depend on its Postgres version, so each is renamed if it is there.
DO $$
DECLARE
	found record;
BEGIN
	FOR found IN
		SELECT conrelid::regclass AS on_table, conname AS name
		FROM pg_constraint
		WHERE connamespace = 'public'::regnamespace AND conname LIKE '%sandbox%'
	LOOP
		EXECUTE format(
			'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
			found.on_table,
			found.name,
			replace(replace(replace(replace(found.name, 'sandbox_agent_allowed_host', 'agent_allowed_host'), 'sandbox_allowed_host', 'allowed_host'), 'sandbox_blocked_host', 'blocked_host'), 'sandbox', 'computer')
		);
	END LOOP;
END $$;
