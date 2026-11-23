-- Connections are connectors, the glossary's word for a service a project is
-- connected to, and a provider's preset is the built-in provider it was made
-- from. Everything named for them is renamed, keeping every row.
ALTER TABLE "connection" RENAME TO "connector";--> statement-breakpoint
ALTER TABLE "model_request" RENAME COLUMN "preset" TO "built_in";--> statement-breakpoint
ALTER TABLE "tool_call" RENAME COLUMN "connection_id" TO "connector_id";--> statement-breakpoint
ALTER TABLE "tool_call" RENAME COLUMN "connection_revision" TO "connector_revision";--> statement-breakpoint
ALTER TABLE "computer_provider" RENAME COLUMN "preset" TO "built_in";--> statement-breakpoint
ALTER TABLE "model_provider" RENAME COLUMN "preset" TO "built_in";--> statement-breakpoint
ALTER TABLE "search_provider" RENAME COLUMN "preset" TO "built_in";--> statement-breakpoint
ALTER TABLE "computer_provider" RENAME CONSTRAINT "computer_provider_preset_check" TO "computer_provider_built_in_check";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_kind_check" TO "connector_kind_check";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_http_auth_check" TO "connector_http_auth_check";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_settings_kind_check" TO "connector_settings_kind_check";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_app_credential_kind_check" TO "connector_app_credential_kind_check";--> statement-breakpoint
ALTER INDEX "connection_name_idx" RENAME TO "connector_name_idx";--> statement-breakpoint
ALTER INDEX "connection_handle_idx" RENAME TO "connector_handle_idx";--> statement-breakpoint
ALTER INDEX "connection_github_project_idx" RENAME TO "connector_github_project_idx";--> statement-breakpoint
ALTER INDEX "connection_id_workspace_id_idx" RENAME TO "connector_id_workspace_id_idx";--> statement-breakpoint
ALTER INDEX "connection_oauth_state_idx" RENAME TO "connector_oauth_state_idx";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_project_workspace_fkey" TO "connector_project_workspace_fkey";--> statement-breakpoint
-- What Postgres named for the table itself: its primary key, its own foreign
-- keys and its columns' not-null constraints.
ALTER TABLE "connector" RENAME CONSTRAINT "connection_pkey" TO "connector_pkey";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_workspace_id_workspace_id_fkey" TO "connector_workspace_id_workspace_id_fkey";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_created_by_id_user_id_fkey" TO "connector_created_by_id_user_id_fkey";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_id_not_null" TO "connector_id_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_workspace_id_not_null" TO "connector_workspace_id_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_project_id_not_null" TO "connector_project_id_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_name_not_null" TO "connector_name_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_handle_not_null" TO "connector_handle_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_kind_not_null" TO "connector_kind_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_url_not_null" TO "connector_url_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_auth_kind_not_null" TO "connector_auth_kind_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_configuration_revision_not_null" TO "connector_configuration_revision_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_tools_not_null" TO "connector_tools_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_tool_access_not_null" TO "connector_tool_access_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_created_at_not_null" TO "connector_created_at_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_updated_at_not_null" TO "connector_updated_at_not_null";--> statement-breakpoint
ALTER TABLE "search_provider" RENAME CONSTRAINT "search_provider_preset_not_null" TO "search_provider_built_in_not_null";--> statement-breakpoint
ALTER TABLE "computer_provider" RENAME CONSTRAINT "computer_provider_preset_not_null" TO "computer_provider_built_in_not_null";--> statement-breakpoint
-- A computer provider's settings name its built-in provider under `builtIn`,
-- which `built_in` is generated from. The key is added before the expression
-- changes, so the column is never null, and the old key removed after.
UPDATE "computer_provider" SET "settings" = "settings" || jsonb_build_object('builtIn', "settings"->'preset');--> statement-breakpoint
ALTER TABLE "computer_provider" ALTER COLUMN "built_in" SET EXPRESSION AS (settings->>'builtIn');--> statement-breakpoint
UPDATE "computer_provider" SET "settings" = "settings" - 'preset';--> statement-breakpoint
UPDATE "computer_provider" SET "managed_resources" = ("managed_resources" - 'preset') || jsonb_build_object('builtIn', "managed_resources"->'preset') WHERE "managed_resources" ? 'preset';--> statement-breakpoint
-- A GitHub trigger, and the run it started, name their connector by `connectorId`.
UPDATE "automation_trigger" SET "settings" = ("settings" - 'connectionId') || jsonb_build_object('connectorId', "settings"->'connectionId') WHERE "settings" ? 'connectionId';--> statement-breakpoint
UPDATE "run" SET "trigger" = ("trigger" - 'connectionId') || jsonb_build_object('connectorId', "trigger"->'connectionId') WHERE "trigger" ? 'connectionId';