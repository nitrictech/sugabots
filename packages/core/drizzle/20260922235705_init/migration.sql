-- Drizzle does not manage extensions. pg_trgm is a trusted extension, so the
-- database owner can create it without being a superuser.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "model_request" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"pod_id" uuid,
	"agent_id" uuid,
	"thread_id" uuid,
	"turn_id" uuid,
	"step" integer NOT NULL,
	"provider_id" uuid NOT NULL,
	"preset" text,
	"model" text NOT NULL,
	"outcome" text NOT NULL,
	"input_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"output_tokens" integer,
	"reasoning_tokens" integer,
	"cost_usd" numeric(18,10),
	"cost_source" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "model_request_purpose_valid" CHECK ("purpose" in ('agent-turn', 'facilitation', 'summary', 'compaction', 'trial', 'provider-check')),
	CONSTRAINT "model_request_outcome_valid" CHECK ("outcome" in ('started', 'completed', 'failed', 'aborted')),
	CONSTRAINT "model_request_ended_valid" CHECK (("outcome" = 'started') = ("ended_at" is null)),
	CONSTRAINT "model_request_cost_valid" CHECK (("cost_usd" is null) = ("cost_source" is null) and ("cost_usd" is null or "cost_usd" >= 0))
);
--> statement-breakpoint
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
CREATE TABLE "thread_compaction" (
	"thread_id" uuid PRIMARY KEY,
	"summary" text NOT NULL,
	"history_starts_at" timestamp with time zone NOT NULL,
	"kept_from" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "thread_read" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_through" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_summary" (
	"thread_id" uuid PRIMARY KEY,
	"content" text NOT NULL,
	"source_message_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"owner" text,
	"status" text NOT NULL,
	"model" text NOT NULL,
	"context_tokens" integer,
	"context_capacity" integer,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
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
	"access" text DEFAULT 'allow' NOT NULL,
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
	"oauth_tokens_encrypted" text,
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
CREATE TABLE "workspace_default_model" (
	"workspace_id" uuid PRIMARY KEY,
	"model_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lane" (
	"key" text PRIMARY KEY,
	"subject" text,
	"state" text DEFAULT 'idle' NOT NULL,
	"workflow" text,
	"execution_id" text,
	"payload" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lane_state_check" CHECK ("state" in ('idle', 'starting', 'running')),
	CONSTRAINT "lane_execution_check" CHECK (("state" = 'idle') = ("execution_id" is null))
);
--> statement-breakpoint
CREATE TABLE "lane_request" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"lane_key" text NOT NULL,
	"workflow" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"color" text NOT NULL,
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
	"color" text,
	"routing" jsonb DEFAULT '{"facilitator":false}' NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pod_kind_check" CHECK ("kind" in ('personal', 'shared')),
	CONSTRAINT "pod_personal_owner_check" CHECK ("kind" = 'shared' or "owner_id" is not null),
	CONSTRAINT "pod_personal_slug_check" CHECK (("kind" = 'personal') = ("slug" = 'personal'))
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
	"referred_by" uuid,
	"referral_code" text,
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
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_invite" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"inviter_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_invite_role_check" CHECK ("role" in ('admin', 'member', 'viewer')),
	CONSTRAINT "workspace_invite_status_check" CHECK ("status" in ('pending', 'accepted', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "workspace_member" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_member_role_check" CHECK ("role" in ('owner', 'admin', 'member', 'viewer'))
);
--> statement-breakpoint
CREATE INDEX "model_request_workspace_started_at_idx" ON "model_request" ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "model_request_thread_idx" ON "model_request" ("thread_id") WHERE "thread_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_pod_host_idx" ON "chat" ("pod_id","host_agent_id");--> statement-breakpoint
CREATE INDEX "collaboration_parent_message_idx" ON "collaboration" ("parent_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_child_thread_idx" ON "collaboration" ("child_thread_id");--> statement-breakpoint
CREATE INDEX "collaboration_collaborator_created_at_idx" ON "collaboration" ("collaborator_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "collaboration_turn_idx" ON "collaboration" ("turn_id");--> statement-breakpoint
CREATE INDEX "message_thread_created_at_idx" ON "message" ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "message_content_search_idx" ON "message" USING gin (to_tsvector('english', "content")) WHERE "status" = 'complete';--> statement-breakpoint
CREATE INDEX "message_content_simple_search_idx" ON "message" USING gin (to_tsvector('simple', "content")) WHERE "status" = 'complete';--> statement-breakpoint
CREATE INDEX "message_content_trigram_idx" ON "message" USING gin ("content" gin_trgm_ops) WHERE "status" = 'complete';--> statement-breakpoint
CREATE UNIQUE INDEX "routine_agent_name_idx" ON "routine" ("agent_id","name") WHERE "deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_id_workspace_id_idx" ON "routine" ("id","workspace_id");--> statement-breakpoint
CREATE INDEX "routine_due_idx" ON "routine" ("next_scheduled_at","id") WHERE "deleted_at" is null and "state" = 'enabled' and "trigger_kind" = 'cron';--> statement-breakpoint
CREATE UNIQUE INDEX "routine_execution_thread_idx" ON "routine_execution" ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_execution_trigger_identity_idx" ON "routine_execution" ("routine_id","trigger_kind","trigger_identity") WHERE "trigger_identity" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_execution_running_idx" ON "routine_execution" ("routine_id") WHERE "state" = 'running';--> statement-breakpoint
CREATE INDEX "routine_execution_list_idx" ON "routine_execution" ("routine_id","accepted_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_system_agent_key_idx" ON "thread" ("parent_thread_id","system_agent_key");--> statement-breakpoint
CREATE INDEX "thread_workspace_created_at_idx" ON "thread" ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "thread_pod_host_created_at_idx" ON "thread" ("pod_id","host_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "thread_workspace_updated_at_idx" ON "thread" ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "thread_pod_host_updated_at_idx" ON "thread" ("pod_id","host_agent_id","updated_at");--> statement-breakpoint
CREATE INDEX "thread_chat_updated_at_idx" ON "thread" ("chat_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_participant_user_idx" ON "thread_participant" ("thread_id","user_id") WHERE "user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "thread_participant_agent_idx" ON "thread_participant" ("thread_id","agent_id") WHERE "agent_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "thread_read_user_thread_idx" ON "thread_read" ("user_id","thread_id");--> statement-breakpoint
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
CREATE INDEX "lane_busy_idx" ON "lane" ("state","updated_at") WHERE "state" <> 'idle';--> statement-breakpoint
CREATE INDEX "lane_subject_idx" ON "lane" ("subject") WHERE "state" <> 'idle';--> statement-breakpoint
CREATE INDEX "lane_request_order_idx" ON "lane_request" ("lane_key","created_at","id");--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_name_idx" ON "agent" ("pod_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_handle_idx" ON "agent" ("pod_id","handle");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_provisioned_key_idx" ON "agent" ("pod_id","provisioned_key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_system_agent_key_idx" ON "agent" ("workspace_id","system_agent_key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_id_workspace_id_idx" ON "agent" ("id","workspace_id");--> statement-breakpoint
CREATE INDEX "agent_pod_id_idx" ON "agent" ("pod_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pod_slug_idx" ON "pod" ("workspace_id","slug") WHERE "kind" = 'shared';--> statement-breakpoint
CREATE UNIQUE INDEX "personal_pod_owner_idx" ON "pod" ("workspace_id","owner_id") WHERE "kind" = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "pod_id_workspace_id_idx" ON "pod" ("id","workspace_id");--> statement-breakpoint
CREATE INDEX "pod_workspace_id_idx" ON "pod" ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pod_member_idx" ON "pod_member" ("pod_id","user_id");--> statement-breakpoint
CREATE INDEX "pod_member_user_id_idx" ON "pod_member" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_idx" ON "session" ("token");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_idx" ON "user" ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "user_referral_code_idx" ON "user" ("referral_code");--> statement-breakpoint
CREATE INDEX "user_referred_by_idx" ON "user" ("referred_by");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_slug_idx" ON "workspace" ("slug");--> statement-breakpoint
CREATE INDEX "workspace_invite_workspace_id_idx" ON "workspace_invite" ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_invite_email_idx" ON "workspace_invite" ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_member_idx" ON "workspace_member" ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "workspace_member_user_id_idx" ON "workspace_member" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_member_owner_idx" ON "workspace_member" ("workspace_id") WHERE "role" = 'owner';--> statement-breakpoint
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
ALTER TABLE "thread_compaction" ADD CONSTRAINT "thread_compaction_thread_id_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "thread_participant" ADD CONSTRAINT "thread_participant_thread_id_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "thread_participant" ADD CONSTRAINT "thread_participant_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "thread_participant" ADD CONSTRAINT "thread_participant_agent_id_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "thread_read" ADD CONSTRAINT "thread_read_thread_id_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "thread_read" ADD CONSTRAINT "thread_read_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "thread_summary" ADD CONSTRAINT "thread_summary_thread_id_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "thread_summary" ADD CONSTRAINT "thread_summary_source_message_id_message_id_fkey" FOREIGN KEY ("source_message_id") REFERENCES "message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tool_call" ADD CONSTRAINT "tool_call_thread_id_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tool_call" ADD CONSTRAINT "tool_call_message_id_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tool_call" ADD CONSTRAINT "tool_call_turn_id_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "turn"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tool_call" ADD CONSTRAINT "tool_call_decided_by_id_user_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "turn" ADD CONSTRAINT "turn_thread_id_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "turn" ADD CONSTRAINT "turn_agent_id_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "turn" ADD CONSTRAINT "turn_trigger_message_id_message_id_fkey" FOREIGN KEY ("trigger_message_id") REFERENCES "message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_pod_workspace_fkey" FOREIGN KEY ("pod_id","workspace_id") REFERENCES "pod"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "provider_model" ADD CONSTRAINT "provider_model_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_model" ADD CONSTRAINT "provider_model_provider_workspace_fkey" FOREIGN KEY ("provider_id","workspace_id") REFERENCES "model_provider"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "search_provider" ADD CONSTRAINT "search_provider_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "search_provider" ADD CONSTRAINT "search_provider_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workspace_default_model" ADD CONSTRAINT "workspace_default_model_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "lane_request" ADD CONSTRAINT "lane_request_lane_key_lane_key_fkey" FOREIGN KEY ("lane_key") REFERENCES "lane"("key") ON DELETE CASCADE;--> statement-breakpoint
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
ALTER TABLE "user" ADD CONSTRAINT "user_referred_by_user_id_fkey" FOREIGN KEY ("referred_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workspace_invite" ADD CONSTRAINT "workspace_invite_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_invite" ADD CONSTRAINT "workspace_invite_inviter_id_user_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint

CREATE FUNCTION enforce_personal_pod_owner_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "pod"
		WHERE "id" = NEW."pod_id"
			AND "kind" = 'personal'
			AND "owner_id" <> NEW."user_id"
	) THEN
		RAISE EXCEPTION 'Only the owner may belong to a personal pod';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER personal_pod_owner_membership
BEFORE INSERT OR UPDATE ON "pod_member"
FOR EACH ROW EXECUTE FUNCTION enforce_personal_pod_owner_membership();--> statement-breakpoint

-- Serialises every write that decides whether an administrator is in a shared pod. Without it, a pod made while somebody is promoted is missed by both: each insert runs before the other commits.
CREATE FUNCTION lock_pod_membership(workspace uuid) RETURNS void
LANGUAGE sql AS $$
	SELECT pg_advisory_xact_lock(hashtext('pod_membership:' || workspace::text));
$$;--> statement-breakpoint

-- The owner and admins are members of every shared pod, so `pod_member` is the whole list of who is in a pod.
CREATE FUNCTION add_administrators_to_new_shared_pod() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM lock_pod_membership(NEW."workspace_id");
	INSERT INTO "pod_member" ("workspace_id", "pod_id", "user_id")
	SELECT NEW."workspace_id", NEW."id", "user_id"
	FROM "workspace_member"
	WHERE "workspace_id" = NEW."workspace_id" AND "role" IN ('owner', 'admin')
	ON CONFLICT ("pod_id", "user_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER shared_pod_administrators
AFTER INSERT ON "pod"
FOR EACH ROW WHEN (NEW."kind" = 'shared')
EXECUTE FUNCTION add_administrators_to_new_shared_pod();--> statement-breakpoint

-- Only adds: somebody demoted keeps the pods they are in, and leaves them one at a time.
CREATE FUNCTION add_new_administrator_to_shared_pods() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM lock_pod_membership(NEW."workspace_id");
	INSERT INTO "pod_member" ("workspace_id", "pod_id", "user_id")
	SELECT NEW."workspace_id", "id", NEW."user_id"
	FROM "pod"
	WHERE "workspace_id" = NEW."workspace_id" AND "kind" = 'shared'
	ON CONFLICT ("pod_id", "user_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER administrator_shared_pods
AFTER INSERT OR UPDATE OF "role" ON "workspace_member"
FOR EACH ROW WHEN (NEW."role" IN ('owner', 'admin'))
EXECUTE FUNCTION add_new_administrator_to_shared_pods();
