CREATE TABLE "chat" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"pod_id" uuid NOT NULL,
	"host_agent_id" uuid NOT NULL,
	"main_thread_id" uuid NOT NULL,
	"initiator_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collaboration" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"parent_thread_id" uuid NOT NULL,
	"parent_message_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"child_thread_id" uuid NOT NULL,
	"collaborator_agent_id" uuid NOT NULL,
	"brief" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"answer" text,
	"at_offset" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"kind" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"deferred_payload" jsonb,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"thread_id" uuid NOT NULL,
	"author_user_id" uuid,
	"author_agent_id" uuid,
	"routine_trigger" jsonb,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"parts" jsonb NOT NULL,
	"content" text NOT NULL,
	"mentions" jsonb DEFAULT '[]' NOT NULL,
	"turn_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_one_author" CHECK (num_nonnulls("author_user_id", "author_agent_id", "routine_trigger") = 1)
);
--> statement-breakpoint
CREATE TABLE "routine" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"instructions" text NOT NULL,
	"trigger_kind" text NOT NULL,
	"cron_expression" text,
	"cron_timezone" text,
	"next_scheduled_at" timestamp with time zone,
	"webhook_secret_digest" text,
	"state" text DEFAULT 'enabled' NOT NULL,
	"created_by_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_state_valid" CHECK ("state" in ('enabled', 'paused')),
	CONSTRAINT "routine_trigger_valid" CHECK ((
				"trigger_kind" = 'cron'
				and "cron_expression" is not null
				and "cron_timezone" is not null
				and "webhook_secret_digest" is null
			) or (
				"trigger_kind" = 'webhook'
				and "cron_expression" is null
				and "cron_timezone" is null
				and "next_scheduled_at" is null
				and "webhook_secret_digest" is not null
			)),
	CONSTRAINT "routine_schedule_state_valid" CHECK ("trigger_kind" <> 'cron'
				or ("state" = 'enabled' and "next_scheduled_at" is not null)
				or ("state" = 'paused' and "next_scheduled_at" is null))
);
--> statement-breakpoint
CREATE TABLE "routine_execution" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"routine_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"trigger_kind" text NOT NULL,
	"trigger_identity" text,
	"trigger" jsonb NOT NULL,
	"routine_name" text NOT NULL,
	"instructions" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"pending_terminal_state" text,
	"pending_terminal_error" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_execution_trigger_valid" CHECK ("trigger_kind" in ('cron', 'webhook', 'manual')
				and "trigger"->>'kind' = "trigger_kind"
				and ("trigger_kind" = 'webhook' or "trigger_identity" is not null)),
	CONSTRAINT "routine_execution_state_valid" CHECK ((
				"state" = 'queued'
				and "started_at" is null
				and "finished_at" is null
				and "error" is null
			) or (
				"state" = 'running'
				and "started_at" is not null
				and "finished_at" is null
			) or (
				"state" in ('completed', 'failed', 'cancelled')
				and "finished_at" is not null
			)),
	CONSTRAINT "routine_execution_pending_terminal_valid" CHECK (("pending_terminal_state" is null and "pending_terminal_error" is null)
				or ("state" = 'running' and "pending_terminal_state" = 'cancelled' and "pending_terminal_error" is null)
				or ("state" = 'running' and "pending_terminal_state" = 'failed'))
);
--> statement-breakpoint
CREATE TABLE "thread" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"pod_id" uuid NOT NULL,
	"host_agent_id" uuid NOT NULL,
	"chat_id" uuid,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"system_agent_key" text,
	"parent_thread_id" uuid,
	"initiator_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_type_valid" CHECK ("type" in ('chat', 'collaboration', 'routine', 'system_agent'))
);
--> statement-breakpoint
CREATE TABLE "thread_participant" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"thread_id" uuid NOT NULL,
	"user_id" uuid,
	"agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_participant_one_identity" CHECK (num_nonnulls("user_id", "agent_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "thread_summary" (
	"thread_id" uuid PRIMARY KEY,
	"content" text NOT NULL,
	"source_message_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_approval_rule" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"pod_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"connection_revision" integer NOT NULL,
	"tool_name" text NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_call" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"thread_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"sdk_tool_call_id" text,
	"approval_id" text,
	"approval_status" text,
	"approval_reason" text,
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone,
	"connection_id" uuid,
	"connection_revision" integer,
	"remote_tool_name" text,
	"execution_input" jsonb,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text,
	"mutating" boolean DEFAULT false NOT NULL,
	"at_offset" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turn" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"thread_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"trigger_message_id" uuid NOT NULL,
	"job_id" uuid,
	"status" text NOT NULL,
	"model" text NOT NULL,
	"usage" jsonb,
	"reported_cost" numeric(18,10),
	"context_tokens" integer,
	"context_capacity" integer,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"mutation_started" boolean DEFAULT false NOT NULL,
	"checkpoint" jsonb,
	"reason" text,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event" (
	"seq" bigserial PRIMARY KEY,
	"channel" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"pod_id" uuid NOT NULL,
	"name" text NOT NULL,
	"handle" text NOT NULL,
	"url" text NOT NULL,
	"auth_kind" text DEFAULT 'header' NOT NULL,
	"secret_header" text,
	"secret_encrypted" text,
	"oauth_encrypted" text,
	"oauth_state" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"allow_mutating" boolean DEFAULT false NOT NULL,
	"configuration_revision" integer DEFAULT 1 NOT NULL,
	"tools" jsonb DEFAULT '[]' NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_test_error" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_provider" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"preset" text,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_format" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"api_key_encrypted" text,
	"custom_headers_encrypted" jsonb DEFAULT '[]' NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_test_error" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_model" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	"display_name" text,
	"capabilities" jsonb DEFAULT '[]' NOT NULL,
	"disabled_capabilities" jsonb DEFAULT '[]' NOT NULL,
	"context_length" integer,
	"enabled" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_provider" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"preset" text NOT NULL,
	"base_url" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"api_key_encrypted" text,
	"last_tested_at" timestamp with time zone,
	"last_test_error" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"password" text,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"pod_id" uuid,
	"name" text NOT NULL,
	"handle" text NOT NULL,
	"system_agent_key" text,
	"provisioned_key" text,
	"description" text,
	"hue" integer NOT NULL,
	"face" text NOT NULL,
	"model" text,
	"prompt" text DEFAULT '' NOT NULL,
	"disabled_tools" jsonb DEFAULT '[]' NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_placement_check" CHECK (("system_agent_key" is null) = ("pod_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "pod" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"routing" jsonb DEFAULT '{"facilitator":false}' NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pod_kind_check" CHECK ("kind" in ('personal', 'shared')),
	CONSTRAINT "pod_personal_owner_check" CHECK ("kind" = 'shared' or "owner_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "pod_member" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"pod_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"token" text NOT NULL,
	"user_id" uuid NOT NULL,
	"active_workspace_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"onboarding_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_invite" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"inviter_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_member" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_pod_host_idx" ON "chat" ("pod_id","host_agent_id");--> statement-breakpoint
CREATE INDEX "collaboration_parent_message_idx" ON "collaboration" ("parent_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_child_thread_idx" ON "collaboration" ("child_thread_id");--> statement-breakpoint
CREATE INDEX "collaboration_collaborator_created_at_idx" ON "collaboration" ("collaborator_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "collaboration_turn_idx" ON "collaboration" ("turn_id");--> statement-breakpoint
CREATE INDEX "job_claim_idx" ON "job" ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "job_thread_idx" ON "job" ("thread_id","kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "job_queued_dedupe_idx" ON "job" ("dedupe_key") WHERE "status" in ('queued', 'waiting');--> statement-breakpoint
CREATE INDEX "message_thread_created_at_idx" ON "message" ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_agent_name_idx" ON "routine" ("agent_id","name") WHERE "deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_id_workspace_id_idx" ON "routine" ("id","workspace_id");--> statement-breakpoint
CREATE INDEX "routine_due_idx" ON "routine" ("next_scheduled_at","id") WHERE "deleted_at" is null and "state" = 'enabled' and "trigger_kind" = 'cron';--> statement-breakpoint
CREATE UNIQUE INDEX "routine_execution_thread_idx" ON "routine_execution" ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_execution_trigger_identity_idx" ON "routine_execution" ("routine_id","trigger_kind","trigger_identity") WHERE "trigger_identity" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_execution_running_idx" ON "routine_execution" ("routine_id") WHERE "state" = 'running';--> statement-breakpoint
CREATE INDEX "routine_execution_dispatch_idx" ON "routine_execution" ("routine_id","state","accepted_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_system_agent_key_idx" ON "thread" ("parent_thread_id","system_agent_key");--> statement-breakpoint
CREATE INDEX "thread_workspace_created_at_idx" ON "thread" ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "thread_pod_host_created_at_idx" ON "thread" ("pod_id","host_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "thread_workspace_updated_at_idx" ON "thread" ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "thread_pod_host_updated_at_idx" ON "thread" ("pod_id","host_agent_id","updated_at");--> statement-breakpoint
CREATE INDEX "thread_chat_updated_at_idx" ON "thread" ("chat_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_participant_user_idx" ON "thread_participant" ("thread_id","user_id") WHERE "user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "thread_participant_agent_idx" ON "thread_participant" ("thread_id","agent_id") WHERE "agent_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_approval_rule_identity_idx" ON "tool_approval_rule" ("agent_id","connection_id","tool_name","created_by_id");--> statement-breakpoint
CREATE INDEX "tool_approval_rule_pod_idx" ON "tool_approval_rule" ("pod_id");--> statement-breakpoint
CREATE INDEX "tool_call_message_idx" ON "tool_call" ("message_id");--> statement-breakpoint
CREATE INDEX "tool_call_turn_idx" ON "tool_call" ("turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_call_sdk_call_idx" ON "tool_call" ("turn_id","sdk_tool_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_call_approval_idx" ON "tool_call" ("approval_id");--> statement-breakpoint
CREATE INDEX "turn_thread_started_at_idx" ON "turn" ("thread_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "turn_trigger_agent_idx" ON "turn" ("trigger_message_id","agent_id");--> statement-breakpoint
CREATE INDEX "turn_active_idx" ON "turn" ("status","started_at") WHERE "status" = 'running';--> statement-breakpoint
CREATE INDEX "event_channel_seq_idx" ON "event" ("channel","seq");--> statement-breakpoint
CREATE INDEX "event_created_at_idx" ON "event" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_name_idx" ON "connection" ("pod_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_handle_idx" ON "connection" ("pod_id","handle");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_id_workspace_id_idx" ON "connection" ("id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_id_pod_id_idx" ON "connection" ("id","pod_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_oauth_state_idx" ON "connection" ("oauth_state");--> statement-breakpoint
CREATE UNIQUE INDEX "model_provider_name_idx" ON "model_provider" ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "model_provider_id_workspace_id_idx" ON "model_provider" ("id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_model_provider_id_idx" ON "provider_model" ("provider_id","model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_model_workspace_id_idx" ON "provider_model" ("workspace_id","model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "search_provider_workspace_idx" ON "search_provider" ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "search_provider_id_workspace_id_idx" ON "search_provider" ("id","workspace_id");--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_name_idx" ON "agent" ("pod_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_handle_idx" ON "agent" ("pod_id","handle");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_provisioned_key_idx" ON "agent" ("pod_id","provisioned_key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_system_agent_key_idx" ON "agent" ("workspace_id","system_agent_key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_id_workspace_id_idx" ON "agent" ("id","workspace_id");--> statement-breakpoint
CREATE INDEX "agent_pod_id_idx" ON "agent" ("pod_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pod_slug_idx" ON "pod" ("workspace_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_pod_owner_idx" ON "pod" ("workspace_id","owner_id") WHERE "kind" = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "pod_id_workspace_id_idx" ON "pod" ("id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pod_member_idx" ON "pod_member" ("pod_id","user_id");--> statement-breakpoint
CREATE INDEX "pod_member_user_id_idx" ON "pod_member" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_idx" ON "session" ("token");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_idx" ON "user" ("email");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_slug_idx" ON "workspace" ("slug");--> statement-breakpoint
CREATE INDEX "workspace_invite_workspace_id_idx" ON "workspace_invite" ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_invite_email_idx" ON "workspace_invite" ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_member_idx" ON "workspace_member" ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "workspace_member_user_id_idx" ON "workspace_member" ("user_id");--> statement-breakpoint
ALTER TABLE "chat" ADD CONSTRAINT "chat_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat" ADD CONSTRAINT "chat_main_thread_id_thread_id_fkey" FOREIGN KEY ("main_thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat" ADD CONSTRAINT "chat_initiator_user_id_user_id_fkey" FOREIGN KEY ("initiator_user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "chat" ADD CONSTRAINT "chat_pod_workspace_fkey" FOREIGN KEY ("pod_id","workspace_id") REFERENCES "pod"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat" ADD CONSTRAINT "chat_host_agent_workspace_fkey" FOREIGN KEY ("host_agent_id","workspace_id") REFERENCES "agent"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "collaboration" ADD CONSTRAINT "collaboration_parent_thread_id_thread_id_fkey" FOREIGN KEY ("parent_thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "collaboration" ADD CONSTRAINT "collaboration_parent_message_id_message_id_fkey" FOREIGN KEY ("parent_message_id") REFERENCES "message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "collaboration" ADD CONSTRAINT "collaboration_turn_id_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "turn"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "collaboration" ADD CONSTRAINT "collaboration_child_thread_id_thread_id_fkey" FOREIGN KEY ("child_thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "collaboration" ADD CONSTRAINT "collaboration_collaborator_agent_id_agent_id_fkey" FOREIGN KEY ("collaborator_agent_id") REFERENCES "agent"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_thread_id_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_thread_id_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_author_user_id_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_author_agent_id_agent_id_fkey" FOREIGN KEY ("author_agent_id") REFERENCES "agent"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_turn_id_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "turn"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "routine" ADD CONSTRAINT "routine_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "routine" ADD CONSTRAINT "routine_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "routine" ADD CONSTRAINT "routine_agent_workspace_fkey" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "agent"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "routine_execution" ADD CONSTRAINT "routine_execution_routine_id_routine_id_fkey" FOREIGN KEY ("routine_id") REFERENCES "routine"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "routine_execution" ADD CONSTRAINT "routine_execution_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "routine_execution" ADD CONSTRAINT "routine_execution_thread_id_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "routine_execution" ADD CONSTRAINT "routine_execution_agent_workspace_fkey" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "agent"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "routine_execution" ADD CONSTRAINT "routine_execution_routine_workspace_fkey" FOREIGN KEY ("routine_id","workspace_id") REFERENCES "routine"("id","workspace_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_chat_id_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chat"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_parent_thread_id_thread_id_fkey" FOREIGN KEY ("parent_thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_initiator_user_id_user_id_fkey" FOREIGN KEY ("initiator_user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_pod_workspace_fkey" FOREIGN KEY ("pod_id","workspace_id") REFERENCES "pod"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_host_agent_workspace_fkey" FOREIGN KEY ("host_agent_id","workspace_id") REFERENCES "agent"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "thread_participant" ADD CONSTRAINT "thread_participant_thread_id_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "thread_participant" ADD CONSTRAINT "thread_participant_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "thread_participant" ADD CONSTRAINT "thread_participant_agent_id_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "thread_summary" ADD CONSTRAINT "thread_summary_thread_id_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "thread_summary" ADD CONSTRAINT "thread_summary_source_message_id_message_id_fkey" FOREIGN KEY ("source_message_id") REFERENCES "message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tool_approval_rule" ADD CONSTRAINT "tool_approval_rule_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tool_approval_rule" ADD CONSTRAINT "tool_approval_rule_agent_id_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tool_approval_rule" ADD CONSTRAINT "tool_approval_rule_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tool_approval_rule" ADD CONSTRAINT "tool_approval_rule_pod_workspace_fkey" FOREIGN KEY ("pod_id","workspace_id") REFERENCES "pod"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tool_approval_rule" ADD CONSTRAINT "tool_approval_rule_connection_pod_fkey" FOREIGN KEY ("connection_id","pod_id") REFERENCES "connection"("id","pod_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tool_call" ADD CONSTRAINT "tool_call_thread_id_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tool_call" ADD CONSTRAINT "tool_call_message_id_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tool_call" ADD CONSTRAINT "tool_call_turn_id_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "turn"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tool_call" ADD CONSTRAINT "tool_call_decided_by_id_user_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "turn" ADD CONSTRAINT "turn_thread_id_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "turn" ADD CONSTRAINT "turn_agent_id_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "turn" ADD CONSTRAINT "turn_trigger_message_id_message_id_fkey" FOREIGN KEY ("trigger_message_id") REFERENCES "message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "turn" ADD CONSTRAINT "turn_job_id_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_pod_workspace_fkey" FOREIGN KEY ("pod_id","workspace_id") REFERENCES "pod"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "provider_model" ADD CONSTRAINT "provider_model_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_model" ADD CONSTRAINT "provider_model_provider_workspace_fkey" FOREIGN KEY ("provider_id","workspace_id") REFERENCES "model_provider"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "search_provider" ADD CONSTRAINT "search_provider_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "search_provider" ADD CONSTRAINT "search_provider_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_pod_workspace_fkey" FOREIGN KEY ("pod_id","workspace_id") REFERENCES "pod"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pod" ADD CONSTRAINT "pod_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pod" ADD CONSTRAINT "pod_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "pod" ADD CONSTRAINT "pod_owner_workspace_member_fkey" FOREIGN KEY ("workspace_id","owner_id") REFERENCES "workspace_member"("workspace_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pod_member" ADD CONSTRAINT "pod_member_pod_workspace_fkey" FOREIGN KEY ("pod_id","workspace_id") REFERENCES "pod"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pod_member" ADD CONSTRAINT "pod_member_workspace_member_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "workspace_member"("workspace_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_active_workspace_id_workspace_id_fkey" FOREIGN KEY ("active_workspace_id") REFERENCES "workspace"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workspace_invite" ADD CONSTRAINT "workspace_invite_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_invite" ADD CONSTRAINT "workspace_invite_inviter_id_user_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;