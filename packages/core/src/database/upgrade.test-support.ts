/**
 * An installation as `main` left it before bots and projects: rows and
 * stored bytes of each kind the upgrade to them has to carry over, for
 * `upgrade.test.ts`. Ids are spelled out so a case names what it checks.
 */

/**
 * The newest migration `main` has. The migration that made bots and projects
 * runs after it, and so does every later one.
 */
export const LAST_MAIN_MIGRATION = "20261111032858_direct_messages";

const workspace = "0000000a-0000-4000-8000-000000000001";

export const legacy = {
	workspace,
	members: {
		/** The owner, so in every shared pod. */
		sam: "0000000b-0000-4000-8000-000000000001",
		/** In the Family and Notes pods. */
		pat: "0000000b-0000-4000-8000-000000000002",
		/** In no shared pod, though she made Budget in Family before she left it. */
		ana: "0000000b-0000-4000-8000-000000000003",
		/** A viewer, with a bot of their own in their personal pod. */
		lee: "0000000b-0000-4000-8000-000000000004",
	},
	provider: "0000000e-0000-4000-8000-000000000000",
	pods: {
		/** Shared, with Planner and Budget. */
		family: "0000000d-0000-4000-8000-000000000001",
		/** Shared, with no bots. */
		notes: "0000000d-0000-4000-8000-000000000002",
		/** Shared, with Rake and Hoe, made in the opposite order to their ids. */
		garden: "0000000d-0000-4000-8000-000000000006",
	},
	bots: {
		planner: "0000000c-0000-4000-8000-000000000001",
		/** Made by Ana, who has left the Family pod since. */
		budget: "0000000c-0000-4000-8000-000000000002",
		/** Pat's Personal Assistant, in their personal pod. */
		patsAssistant: "0000000c-0000-4000-8000-000000000003",
		/** Pat's bot, in their personal pod beside their Personal Assistant. */
		helper: "0000000c-0000-4000-8000-000000000004",
		/** In the Garden pod, made after Hoe though its id comes first. */
		rake: "0000000c-0000-4000-8000-000000000011",
		/** In the Garden pod, the first bot made there. */
		hoe: "0000000c-0000-4000-8000-000000000012",
		/** Lee's bot, in their personal pod. */
		sketch: "0000000c-0000-4000-8000-000000000007",
	},
	/** Each pod's computer, by its provider's id. */
	computers: {
		family: { id: "00000005-0000-4000-8000-000000000001", providerId: "os-family" },
		/** Made before computers recorded their image. */
		notes: { id: "00000005-0000-4000-8000-000000000002", providerId: "os-notes" },
		/** Pat's personal pod's. */
		pat: { id: "00000005-0000-4000-8000-000000000003", providerId: "os-pat" },
		/** Ana's personal pod's, which has no bots. */
		ana: { id: "00000005-0000-4000-8000-000000000004", providerId: "os-ana" },
	},
	threads: {
		/** The Family pod's main chat, which nobody started. */
		general: "0000000f-0000-4000-8000-000000000001",
		trip: "0000000f-0000-4000-8000-000000000002",
		shopping: "0000000f-0000-4000-8000-000000000004",
		report: "0000000f-0000-4000-8000-000000000005",
		/** Deleted, with its folder's deletion still queued. */
		deleted: "0000000f-0000-4000-8000-0000000000dd",
	},
	/** Messages of the Trip thread: the one Planner's turn answers, and its reply. */
	tripMessages: {
		asked: "00000001-0000-4000-8000-000000000001",
		answered: "00000001-0000-4000-8000-000000000002",
	},
	/**
	 * A routine's runs that main's `routine` workflow held in its lane: one it
	 * was carrying out, and one waiting.
	 */
	/** The routine those runs are of. */
	routine: "00000008-0000-4000-8000-000000000001",
	routineRuns: {
		running: "00000009-0000-4000-8000-000000000001",
		waiting: "00000009-0000-4000-8000-000000000002",
	},
	/** A routine with a webhook trigger main kept only a digest of the bearer secret for. */
	digestOnlyWebhook: {
		automation: "00000008-0000-4000-8000-000000000002",
		trigger: "00000010-0000-4000-8000-000000000001",
	},
	familyGitHubConnector: "00000011-0000-4000-8000-000000000002",
	/** The Notes pod's connection, which no bot had. */
	notesConnection: "00000011-0000-4000-8000-000000000003",
	/** Ana's file, in her personal pod, which had no bots and no chat left. */
	diary: "00000006-0000-4000-8000-000000000004",
	/** A file written in the Notes pod, which has no bots and no main chat, whose chat is gone. */
	groceries: "00000006-0000-4000-8000-000000000005",
	/** A file a bot wrote, deleted, with its folder's deletion still queued. */
	deletedArtifact: "00000006-0000-4000-8000-0000000000dd",
	/** What a summary of Trip cost, in {@link legacySummaryRequest}. */
	summaryRequest: "00000015-0000-4000-8000-0000000000aa",
	facilitationRequest: "00000015-0000-4000-8000-000000000003",
	/** Direct messages between people, which the upgrade deletes. */
	directMessages: {
		/** Sam and Pat's, with a file Sam sent. */
		samAndPat: "0000000f-0000-4000-8000-0000000000d1",
		/** Sam, Pat and Ana's. */
		group: "0000000f-0000-4000-8000-0000000000d2",
	},
} as const;

/** A file whose bytes the upgrade keeps: kept whole in a thread, or one version of one a bot wrote. */
export type LegacyFile =
	| { kind: "thread"; threadId: string; fileId: string; text: string }
	| { kind: "version"; fileId: string; versionId: string; text: string };

const orphanedCollaboration = "0000000f-0000-4000-8000-000000000021";
const askingBot = "0000000c-0000-4000-8000-000000000020";
const askingTurn = "00000002-0000-4000-8000-000000000124";
const askingReply = "00000001-0000-4000-8000-000000000125";

export const migrationScale = {
	memberlessWorkspace: "0000000a-0000-4000-8000-000000000002",
	memberlessPod: "0000000d-0000-4000-8000-000000000020",
	memberlessGeneral: "0000000f-0000-4000-8000-000000000020",
	orphanedCollaboration,
	collaborationReply: "00000001-0000-4000-8000-000000000124",
	hostlessPersonalChat: "0000000f-0000-4000-8000-000000000022",
	unattributedRequest: "00000015-0000-4000-8000-000000000020",
	unclaimedRun: "00000009-0000-4000-8000-000000000003",
	resultRun: "00000009-0000-4000-8000-000000000004",
	feed: "0000000f-0000-4000-8000-00000000000a",
	feedResult: "00000001-0000-4000-8000-000000000120",
	chatResult: "00000001-0000-4000-8000-000000000121",
	reservedBot: "0000000c-0000-4000-8000-000000000006",
	cyclicChat: "0000000f-0000-4000-8000-000000000025",
	files: {
		collaborationAttachment: {
			kind: "thread",
			threadId: orphanedCollaboration,
			fileId: "00000004-0000-4000-8000-000000000021",
			text: "Budget breakdown",
		},
		collaboration: {
			kind: "version",
			fileId: "00000006-0000-4000-8000-000000000020",
			versionId: "00000007-0000-4000-8000-000000000020",
			text: "# Budget",
		},
		personal: {
			kind: "version",
			fileId: "00000006-0000-4000-8000-000000000021",
			versionId: "00000007-0000-4000-8000-000000000021",
			text: "# Personal notes",
		},
	},
} as const;

export const legacyFiles: readonly LegacyFile[] = [
	{
		kind: "thread",
		threadId: legacy.threads.trip,
		fileId: "00000004-0000-4000-8000-000000000001",
		text: "plan",
	},
	{
		kind: "thread",
		threadId: legacy.threads.trip,
		fileId: "00000004-0000-4000-8000-000000000002",
		text: "fetched page",
	},
	{
		kind: "thread",
		threadId: legacy.threads.report,
		fileId: "00000004-0000-4000-8000-000000000003",
		text: "search results",
	},
	{
		kind: "thread",
		threadId: legacy.threads.report,
		fileId: "00000004-0000-4000-8000-000000000004",
		text: "# Report",
	},
	{
		kind: "thread",
		threadId: legacy.threads.shopping,
		fileId: "00000004-0000-4000-8000-000000000005",
		text: "milk",
	},
	{
		kind: "version",
		fileId: "00000006-0000-4000-8000-000000000001",
		versionId: "00000007-0000-4000-8000-000000000001",
		text: "# Itinerary",
	},
	{
		kind: "version",
		fileId: legacy.diary,
		versionId: "00000007-0000-4000-8000-000000000004",
		text: "Dear.",
	},
	{
		kind: "version",
		fileId: legacy.groceries,
		versionId: "00000007-0000-4000-8000-000000000005",
		text: "Eggs",
	},
];

/** Where `main` kept a legacy file's bytes. */
export function legacyKeyOf(file: LegacyFile): string {
	return file.kind === "thread"
		? `threads/${file.threadId}/files/${file.fileId}`
		: `artifacts/${file.fileId}/versions/${file.versionId}`;
}

/**
 * Bytes under folders whose deletion is queued, or is queued by the upgrade,
 * which go once the queue is worked through.
 */
export const bytesQueuedForDeletion = [
	{
		legacyKey: `threads/${legacy.threads.deleted}/files/gone`,
		upgradedKey: `chats/${legacy.threads.deleted}/files/gone`,
	},
	{
		legacyKey: `artifacts/${legacy.deletedArtifact}/versions/gone`,
		upgradedKey: `files/${legacy.deletedArtifact}/versions/gone`,
	},
	{
		legacyKey: `threads/${legacy.directMessages.samAndPat}/files/00000004-0000-4000-8000-0000000000d1`,
		upgradedKey: `chats/${legacy.directMessages.samAndPat}/files/00000004-0000-4000-8000-0000000000d1`,
	},
] as const;

/** Every byte `main` stored, at its legacy key, as the Postgres blob store keeps it. */
export const legacyBytes: readonly { key: string; text: string }[] = [
	...legacyFiles.map((file) => ({ key: legacyKeyOf(file), text: file.text })),
	...bytesQueuedForDeletion.map(({ legacyKey }) => ({ key: legacyKey, text: "deleted" })),
];

/** The rows, written to a database migrated to {@link LAST_MAIN_MIGRATION}. */
export const legacyRows = `
-- Workspace, members and the computer provider.
INSERT INTO "workspace" ("id", "name", "slug") VALUES ('0000000a-0000-4000-8000-000000000001', 'Rivera Family', 'rivera');
INSERT INTO "user" ("id", "name", "email") VALUES
 ('0000000b-0000-4000-8000-000000000001', 'Sam Rivera', 'sam@example.com'),
 ('0000000b-0000-4000-8000-000000000002', 'Pat Rivera', 'pat@example.com'),
 ('0000000b-0000-4000-8000-000000000003', 'Ana Rivera', 'ana@example.com'),
 ('0000000b-0000-4000-8000-000000000004', 'Lee Rivera', 'lee@example.com');
INSERT INTO "workspace_member" ("workspace_id", "user_id", "role") VALUES
 ('0000000a-0000-4000-8000-000000000001', '0000000b-0000-4000-8000-000000000001', 'owner'),
 ('0000000a-0000-4000-8000-000000000001', '0000000b-0000-4000-8000-000000000002', 'member'),
 ('0000000a-0000-4000-8000-000000000001', '0000000b-0000-4000-8000-000000000003', 'member'),
 ('0000000a-0000-4000-8000-000000000001', '0000000b-0000-4000-8000-000000000004', 'viewer');
INSERT INTO "sandbox_provider" ("id", "workspace_id", "settings", "enabled") VALUES
 ('0000000e-0000-4000-8000-000000000000', '0000000a-0000-4000-8000-000000000001', '{"preset":"opensandbox","image":"sugabots-computer:1"}', true);

-- Pods: a shared one with bots, a shared one with none, Pat's personal one
-- with a Personal Assistant and a bot, Ana's personal one with no bots,
-- Lee's personal one with a bot, and another shared one with bots.
INSERT INTO "pod" ("id", "workspace_id", "kind", "name", "slug", "owner_id", "created_by_id", "created_at") VALUES
 ('0000000d-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000001', 'shared', 'Family', 'family', NULL, '0000000b-0000-4000-8000-000000000001', '2026-10-01 09:00'),
 ('0000000d-0000-4000-8000-000000000002', '0000000a-0000-4000-8000-000000000001', 'shared', 'Notes', 'notes', NULL, '0000000b-0000-4000-8000-000000000002', '2026-10-02 09:00'),
 ('0000000d-0000-4000-8000-000000000003', '0000000a-0000-4000-8000-000000000001', 'personal', 'Personal', 'personal', '0000000b-0000-4000-8000-000000000002', '0000000b-0000-4000-8000-000000000002', '2026-10-03 09:00'),
 ('0000000d-0000-4000-8000-000000000004', '0000000a-0000-4000-8000-000000000001', 'personal', 'Personal', 'personal', '0000000b-0000-4000-8000-000000000003', '0000000b-0000-4000-8000-000000000003', '2026-10-04 09:00'),
 ('0000000d-0000-4000-8000-000000000005', '0000000a-0000-4000-8000-000000000001', 'personal', 'Personal', 'personal', '0000000b-0000-4000-8000-000000000004', '0000000b-0000-4000-8000-000000000004', '2026-10-04 10:00'),
 ('0000000d-0000-4000-8000-000000000006', '0000000a-0000-4000-8000-000000000001', 'shared', 'Garden', 'garden', NULL, '0000000b-0000-4000-8000-000000000001', '2026-10-08 09:00');
INSERT INTO "pod_member" ("workspace_id", "pod_id", "user_id") VALUES
 ('0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000001', '0000000b-0000-4000-8000-000000000002'),
 ('0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000002', '0000000b-0000-4000-8000-000000000002'),
 ('0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000003', '0000000b-0000-4000-8000-000000000002'),
 ('0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000004', '0000000b-0000-4000-8000-000000000003'),
 ('0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000005', '0000000b-0000-4000-8000-000000000004')
ON CONFLICT DO NOTHING;
INSERT INTO "agent" ("id", "workspace_id", "pod_id", "name", "handle", "provisioned_key", "color", "face", "model", "created_by_id", "created_at") VALUES
 ('0000000c-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000001', 'Planner', 'planner', NULL, 'rose', 'pill', 'm', '0000000b-0000-4000-8000-000000000001', '2026-10-01 09:01'),
 ('0000000c-0000-4000-8000-000000000002', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000001', 'Budget', 'budget', NULL, 'sky', 'dot', 'm', '0000000b-0000-4000-8000-000000000003', '2026-10-01 09:02'),
 ('0000000c-0000-4000-8000-000000000003', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000003', 'Personal Assistant', 'personal-assistant', 'personal-assistant', 'teal', 'arc', 'm', '0000000b-0000-4000-8000-000000000002', '2026-10-03 09:01'),
 ('0000000c-0000-4000-8000-000000000004', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000003', 'Helper', 'helper', NULL, 'lime', 'wink', 'm', '0000000b-0000-4000-8000-000000000002', '2026-10-03 09:02'),
 ('0000000c-0000-4000-8000-000000000011', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000006', 'Rake', 'rake', NULL, 'rose', 'pill', 'm', '0000000b-0000-4000-8000-000000000001', '2026-10-08 09:02'),
 ('0000000c-0000-4000-8000-000000000012', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000006', 'Hoe', 'hoe', NULL, 'sky', 'dot', 'm', '0000000b-0000-4000-8000-000000000001', '2026-10-08 09:01'),
 ('0000000c-0000-4000-8000-000000000007', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000005', 'Sketch', 'sketch', NULL, 'lime', 'wink', 'm', '0000000b-0000-4000-8000-000000000004', '2026-10-04 10:01');
INSERT INTO "agent" ("id", "workspace_id", "name", "handle", "system_agent_key", "color", "face") VALUES
 ('0000000c-0000-4000-8000-000000000009', '0000000a-0000-4000-8000-000000000001', 'Compaction', 'compaction', 'compaction', 'rose', 'pill');

-- The Family pod's calendar, which its bots used, and the Notes pod's docs,
-- which has no bots.
INSERT INTO "connection" ("id", "workspace_id", "pod_id", "name", "handle", "kind", "url", "auth_kind", "tools", "created_by_id", "created_at") VALUES
 ('00000011-0000-4000-8000-000000000010', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000001', 'Calendar', 'calendar', 'http', 'https://calendar.example.com', 'header', '[]', '0000000b-0000-4000-8000-000000000001', '2026-10-01 09:03'),
 ('00000011-0000-4000-8000-000000000003', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000002', 'Docs', 'docs', 'http', 'https://docs.example.com', 'header', '[]', '0000000b-0000-4000-8000-000000000002', '2026-10-02 09:02');

-- Each pod's computer.
INSERT INTO "sandbox" ("id", "workspace_id", "pod_id", "sandbox_provider_id", "provider_sandbox_id", "image") VALUES
 ('00000005-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000001', '0000000e-0000-4000-8000-000000000000', 'os-family', 'sugabots-computer@sha256:1'),
 ('00000005-0000-4000-8000-000000000002', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000002', '0000000e-0000-4000-8000-000000000000', 'os-notes', NULL),
 ('00000005-0000-4000-8000-000000000003', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000003', '0000000e-0000-4000-8000-000000000000', 'os-pat', 'sugabots-computer@sha256:1'),
 ('00000005-0000-4000-8000-000000000004', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000004', '0000000e-0000-4000-8000-000000000000', 'os-ana', NULL);

-- Threads: the Family pod's main chat and a chat Sam started, a conversation
-- with Planner, the Notes pod's chat, and a conversation with Pat's Helper.
INSERT INTO "thread" ("id", "workspace_id", "pod_id", "host_agent_id", "type", "main", "title", "initiator_user_id", "conversation_id", "created_at") VALUES
 ('0000000f-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000001', NULL, 'pod_chat', true, 'General', NULL, '0000000f-0000-4000-8000-000000000001', '2026-10-01 09:00'),
 ('0000000f-0000-4000-8000-000000000002', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000001', NULL, 'pod_chat', false, 'Trip', '0000000b-0000-4000-8000-000000000001', '0000000f-0000-4000-8000-000000000002', '2026-10-05 09:00'),
 ('0000000f-0000-4000-8000-000000000003', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000001', '0000000c-0000-4000-8000-000000000001', 'conversation', false, 'Ask Planner', '0000000b-0000-4000-8000-000000000001', '0000000f-0000-4000-8000-000000000003', '2026-10-05 10:00'),
 ('0000000f-0000-4000-8000-000000000004', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000002', NULL, 'pod_chat', false, 'Shopping', '0000000b-0000-4000-8000-000000000002', '0000000f-0000-4000-8000-000000000004', '2026-10-06 09:00'),
 ('0000000f-0000-4000-8000-000000000005', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000003', '0000000c-0000-4000-8000-000000000004', 'conversation', false, 'Report', '0000000b-0000-4000-8000-000000000002', '0000000f-0000-4000-8000-000000000005', '2026-10-07 09:00');
UPDATE "thread" SET "done_at" = '2026-10-07 12:00+00'
WHERE "id" = '0000000f-0000-4000-8000-000000000002';
INSERT INTO "thread_participant" ("thread_id", "user_id", "agent_id") VALUES
 ('0000000f-0000-4000-8000-000000000002', '0000000b-0000-4000-8000-000000000001', NULL),
 ('0000000f-0000-4000-8000-000000000002', NULL, '0000000c-0000-4000-8000-000000000001'),
 ('0000000f-0000-4000-8000-000000000003', '0000000b-0000-4000-8000-000000000001', NULL),
 ('0000000f-0000-4000-8000-000000000003', NULL, '0000000c-0000-4000-8000-000000000001'),
 ('0000000f-0000-4000-8000-000000000004', '0000000b-0000-4000-8000-000000000002', NULL),
 ('0000000f-0000-4000-8000-000000000005', '0000000b-0000-4000-8000-000000000002', NULL),
 ('0000000f-0000-4000-8000-000000000005', NULL, '0000000c-0000-4000-8000-000000000004');

-- Messages, turns and tool calls.
INSERT INTO "message" ("id", "thread_id", "author_user_id", "author_agent_id", "kind", "status", "parts", "content", "created_at") VALUES
 ('00000001-0000-4000-8000-000000000001', '0000000f-0000-4000-8000-000000000002', '0000000b-0000-4000-8000-000000000001', NULL, 'text', 'complete', '[{"type":"text","text":"Plan the trip"}]', 'Plan the trip', '2026-10-05 09:01'),
 ('00000001-0000-4000-8000-000000000002', '0000000f-0000-4000-8000-000000000002', NULL, '0000000c-0000-4000-8000-000000000001', 'text', 'complete', '[{"type":"text","text":"Done."}]', 'Done.', '2026-10-05 09:02'),
 ('00000001-0000-4000-8000-000000000003', '0000000f-0000-4000-8000-000000000004', '0000000b-0000-4000-8000-000000000002', NULL, 'text', 'complete', '[{"type":"text","text":"The list"}]', 'The list', '2026-10-06 09:01'),
 ('00000001-0000-4000-8000-000000000004', '0000000f-0000-4000-8000-000000000005', '0000000b-0000-4000-8000-000000000002', NULL, 'text', 'complete', '[{"type":"text","text":"Write the report"}]', 'Write the report', '2026-10-07 09:01'),
 ('00000001-0000-4000-8000-000000000005', '0000000f-0000-4000-8000-000000000005', NULL, '0000000c-0000-4000-8000-000000000004', 'text', 'complete', '[{"type":"text","text":"Attached."}]', 'Attached.', '2026-10-07 09:02');
INSERT INTO "message" ("id", "thread_id", "author_user_id", "kind", "status", "parts", "content", "created_at")
VALUES ('00000001-0000-4000-8000-000000000006', '0000000f-0000-4000-8000-000000000001',
 '0000000b-0000-4000-8000-000000000001', 'text', 'complete',
 '[{"type":"text","text":"We should plan a trip."}]', 'We should plan a trip.', '2026-10-05 08:59');
UPDATE "thread" SET "origin_message_id" = '00000001-0000-4000-8000-000000000006'
WHERE "id" = '0000000f-0000-4000-8000-000000000002';
INSERT INTO "turn" ("id", "thread_id", "agent_id", "trigger_message_id", "status", "model", "reason", "started_at", "finished_at") VALUES
 ('00000002-0000-4000-8000-000000000001', '0000000f-0000-4000-8000-000000000002', '0000000c-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000001', 'done', 'm', 'mention', '2026-10-05 09:01', '2026-10-05 09:02'),
 ('00000002-0000-4000-8000-000000000002', '0000000f-0000-4000-8000-000000000005', '0000000c-0000-4000-8000-000000000004', '00000001-0000-4000-8000-000000000004', 'done', 'm', 'mention', '2026-10-07 09:01', '2026-10-07 09:02');
UPDATE "message" SET "turn_id" = '00000002-0000-4000-8000-000000000001' WHERE "id" = '00000001-0000-4000-8000-000000000002';
UPDATE "message" SET "turn_id" = '00000002-0000-4000-8000-000000000002' WHERE "id" = '00000001-0000-4000-8000-000000000005';
INSERT INTO "tool_call" ("id", "thread_id", "message_id", "turn_id", "tool", "input", "status", "at_offset") VALUES
 ('00000003-0000-4000-8000-000000000001', '0000000f-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000002', '00000002-0000-4000-8000-000000000001', 'web_fetch', '{}', 'completed', 0),
 ('00000003-0000-4000-8000-000000000002', '0000000f-0000-4000-8000-000000000005', '00000001-0000-4000-8000-000000000005', '00000002-0000-4000-8000-000000000002', 'web_fetch', '{}', 'completed', 0);

-- Files kept whole in a thread, and a file a bot wrote.
INSERT INTO "thread_file" ("id", "thread_id", "kind", "name", "content_type", "size", "tool_call_id", "uploader_id", "message_id", "position") VALUES
 ('00000004-0000-4000-8000-000000000001', '0000000f-0000-4000-8000-000000000002', 'upload', 'plan.txt', 'text/plain', 4, NULL, '0000000b-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000001', 0),
 ('00000004-0000-4000-8000-000000000002', '0000000f-0000-4000-8000-000000000002', 'tool_result', NULL, 'text/plain', 6, '00000003-0000-4000-8000-000000000001', NULL, NULL, NULL),
 ('00000004-0000-4000-8000-000000000003', '0000000f-0000-4000-8000-000000000005', 'tool_result', NULL, 'text/plain', 6, '00000003-0000-4000-8000-000000000002', NULL, NULL, NULL),
 ('00000004-0000-4000-8000-000000000004', '0000000f-0000-4000-8000-000000000005', 'agent_attachment', 'report.md', 'text/markdown', 6, NULL, NULL, '00000001-0000-4000-8000-000000000005', 0),
 ('00000004-0000-4000-8000-000000000005', '0000000f-0000-4000-8000-000000000004', 'upload', 'list.txt', 'text/plain', 4, NULL, '0000000b-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000003', 0);
INSERT INTO "artifact" ("id", "workspace_id", "pod_id", "kind", "title", "current_version", "created_by_agent_id", "created_in_thread_id") VALUES
 ('00000006-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000001', 'document', 'Itinerary', 1, '0000000c-0000-4000-8000-000000000001', '0000000f-0000-4000-8000-000000000002');
INSERT INTO "artifact_version" ("id", "artifact_id", "number", "content_type", "size", "author_agent_id") VALUES
 ('00000007-0000-4000-8000-000000000001', '00000006-0000-4000-8000-000000000001', 1, 'text/markdown', 9, '0000000c-0000-4000-8000-000000000001');
-- Ana's diary, in her personal pod, whose chat and bots are all gone.
INSERT INTO "artifact" ("id", "workspace_id", "pod_id", "kind", "title", "current_version", "created_by_agent_id", "created_in_thread_id") VALUES
 ('00000006-0000-4000-8000-000000000004', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000004', 'document', 'Diary', 1, NULL, NULL);
INSERT INTO "artifact_version" ("id", "artifact_id", "number", "content_type", "size") VALUES
 ('00000007-0000-4000-8000-000000000004', '00000006-0000-4000-8000-000000000004', 1, 'text/markdown', 5);
-- Groceries, written in the Notes pod in a chat deleted since.
INSERT INTO "artifact" ("id", "workspace_id", "pod_id", "kind", "title", "current_version", "created_by_agent_id", "created_in_thread_id") VALUES
 ('00000006-0000-4000-8000-000000000005', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000002', 'document', 'Groceries', 1, NULL, NULL);
INSERT INTO "artifact_version" ("id", "artifact_id", "number", "content_type", "size") VALUES
 ('00000007-0000-4000-8000-000000000005', '00000006-0000-4000-8000-000000000005', 1, 'text/markdown', 4);

-- Deletions queued and not yet done: a thread's folder and a written file's.
INSERT INTO "blob_deletion" ("prefix") VALUES
 ('threads/0000000f-0000-4000-8000-0000000000dd'),
 ('artifacts/00000006-0000-4000-8000-0000000000dd');

-- Work in lanes as main's workflows left it: Planner's turn in the Trip
-- thread running, with a turn a routine asked for waiting behind it; a
-- compaction starting; a summary running; and a routine carrying out one run
-- with another waiting.
INSERT INTO "routine" ("id", "workspace_id", "agent_id", "name", "instructions") VALUES
 ('00000008-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000001', '0000000c-0000-4000-8000-000000000001', 'Daily digest', 'Sum up the day');
INSERT INTO "thread" ("id", "workspace_id", "pod_id", "host_agent_id", "type", "title", "conversation_id") VALUES
 ('0000000f-0000-4000-8000-000000000006', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000001', '0000000c-0000-4000-8000-000000000001', 'routine', 'Daily digest', '0000000f-0000-4000-8000-000000000006'),
 ('0000000f-0000-4000-8000-000000000007', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000001', '0000000c-0000-4000-8000-000000000001', 'routine', 'Daily digest', '0000000f-0000-4000-8000-000000000007');
INSERT INTO "routine_execution" ("id", "routine_id", "workspace_id", "agent_id", "thread_id", "trigger_kind", "trigger_identity", "trigger", "routine_name", "instructions", "state", "started_at") VALUES
 ('00000009-0000-4000-8000-000000000001', '00000008-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000001', '0000000c-0000-4000-8000-000000000001', '0000000f-0000-4000-8000-000000000006', 'manual', 'first', '{"kind":"manual"}', 'Daily digest', 'Sum up the day', 'running', '2026-10-08 09:00'),
 ('00000009-0000-4000-8000-000000000002', '00000008-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000001', '0000000c-0000-4000-8000-000000000001', '0000000f-0000-4000-8000-000000000007', 'manual', 'second', '{"kind":"manual"}', 'Daily digest', 'Sum up the day', 'queued', NULL);
INSERT INTO "lane" ("key", "subject", "state", "workflow", "execution_id", "payload", "updated_at") VALUES
 ('turn:0000000f-0000-4000-8000-000000000002:0000000c-0000-4000-8000-000000000001', '0000000f-0000-4000-8000-000000000002', 'running', 'turn', 'execution-turn', '{"threadId":"0000000f-0000-4000-8000-000000000002","agentId":"0000000c-0000-4000-8000-000000000001","triggerMessageId":"00000001-0000-4000-8000-000000000001","reason":"mention"}', '2026-10-08 09:00'),
 ('compaction:0000000f-0000-4000-8000-000000000002', '0000000f-0000-4000-8000-000000000002', 'starting', 'compaction', 'execution-compaction', '{"threadId":"0000000f-0000-4000-8000-000000000002","agentId":"0000000c-0000-4000-8000-000000000001","sourceMessageId":"00000001-0000-4000-8000-000000000002","readKeptFrom":null}', '2026-10-08 09:00'),
 ('summary:0000000f-0000-4000-8000-000000000002', '0000000f-0000-4000-8000-000000000002', 'running', 'summary', 'execution-summary', '{"threadId":"0000000f-0000-4000-8000-000000000002","agentId":"0000000c-0000-4000-8000-000000000001","sourceMessageId":"00000001-0000-4000-8000-000000000002"}', '2026-10-08 09:00'),
 ('routine:00000008-0000-4000-8000-000000000001', '0000000f-0000-4000-8000-000000000006', 'running', 'routine', 'execution-routine', '{"routineId":"00000008-0000-4000-8000-000000000001","executionId":"00000009-0000-4000-8000-000000000001"}', '2026-10-08 09:00');
INSERT INTO "lane_request" ("lane_key", "workflow", "payload") VALUES
 ('turn:0000000f-0000-4000-8000-000000000002:0000000c-0000-4000-8000-000000000001', 'turn', '{"threadId":"0000000f-0000-4000-8000-000000000002","agentId":"0000000c-0000-4000-8000-000000000001","triggerMessageId":"00000001-0000-4000-8000-000000000002","reason":"routine"}'),
 ('summary:0000000f-0000-4000-8000-000000000002', 'summary', '{"threadId":"0000000f-0000-4000-8000-000000000002","agentId":"0000000c-0000-4000-8000-000000000001","sourceMessageId":"00000001-0000-4000-8000-000000000002"}'),
 ('routine:00000008-0000-4000-8000-000000000001', 'routine', '{"routineId":"00000008-0000-4000-8000-000000000001","executionId":"00000009-0000-4000-8000-000000000002"}');

-- A webhook trigger main kept only a digest of the bearer secret for.
INSERT INTO "routine" ("id", "workspace_id", "agent_id", "name", "instructions") VALUES
 ('00000008-0000-4000-8000-000000000002', '0000000a-0000-4000-8000-000000000001', '0000000c-0000-4000-8000-000000000001', 'Deploy check', 'Check the deploy');
INSERT INTO "routine_trigger" ("id", "workspace_id", "routine_id", "settings", "secret_digest") VALUES
 ('00000010-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000001', '00000008-0000-4000-8000-000000000002', '{"kind":"webhook","auth":{"kind":"bearer"},"deliveryIdHeader":null}', 'a2f1c0ffee5a2f1c0ffee5a2f1c0ffee5a2f1c0ffee5a2f1c0ffee5a2f1c0ff');
-- Direct messages: Sam and Pat's, where Sam sent a file Pat has read, and a
-- group of three.
INSERT INTO "thread" ("id", "workspace_id", "pod_id", "host_agent_id", "type", "title", "initiator_user_id", "conversation_id", "direct_key", "created_at") VALUES
 ('0000000f-0000-4000-8000-0000000000d1', '0000000a-0000-4000-8000-000000000001', NULL, NULL, 'direct', 'Sam Rivera, Pat Rivera', '0000000b-0000-4000-8000-000000000001', '0000000f-0000-4000-8000-0000000000d1', '0000000b-0000-4000-8000-000000000001:0000000b-0000-4000-8000-000000000002', '2026-10-09 09:00'),
 ('0000000f-0000-4000-8000-0000000000d2', '0000000a-0000-4000-8000-000000000001', NULL, NULL, 'direct', 'Sam Rivera, Pat Rivera, Ana Rivera', '0000000b-0000-4000-8000-000000000002', '0000000f-0000-4000-8000-0000000000d2', '0000000b-0000-4000-8000-000000000001:0000000b-0000-4000-8000-000000000002:0000000b-0000-4000-8000-000000000003', '2026-10-09 10:00');
INSERT INTO "direct_member" ("thread_id", "user_id") VALUES
 ('0000000f-0000-4000-8000-0000000000d1', '0000000b-0000-4000-8000-000000000001'),
 ('0000000f-0000-4000-8000-0000000000d1', '0000000b-0000-4000-8000-000000000002'),
 ('0000000f-0000-4000-8000-0000000000d2', '0000000b-0000-4000-8000-000000000001'),
 ('0000000f-0000-4000-8000-0000000000d2', '0000000b-0000-4000-8000-000000000002'),
 ('0000000f-0000-4000-8000-0000000000d2', '0000000b-0000-4000-8000-000000000003');
INSERT INTO "message" ("id", "thread_id", "author_user_id", "kind", "status", "parts", "content", "created_at") VALUES
 ('00000001-0000-4000-8000-0000000000d1', '0000000f-0000-4000-8000-0000000000d1', '0000000b-0000-4000-8000-000000000001', 'text', 'complete', '[{"type":"text","text":"The tickets"}]', 'The tickets', '2026-10-09 09:01'),
 ('00000001-0000-4000-8000-0000000000d2', '0000000f-0000-4000-8000-0000000000d2', '0000000b-0000-4000-8000-000000000002', 'text', 'complete', '[{"type":"text","text":"Dinner?"}]', 'Dinner?', '2026-10-09 10:01');
INSERT INTO "thread_file" ("id", "thread_id", "kind", "name", "content_type", "size", "uploader_id", "message_id", "position") VALUES
 ('00000004-0000-4000-8000-0000000000d1', '0000000f-0000-4000-8000-0000000000d1', 'upload', 'tickets.pdf', 'text/plain', 7, '0000000b-0000-4000-8000-000000000001', '00000001-0000-4000-8000-0000000000d1', 0);
INSERT INTO "thread_read" ("thread_id", "user_id", "read_through") VALUES
 ('0000000f-0000-4000-8000-0000000000d1', '0000000b-0000-4000-8000-000000000002', '2026-10-09 09:01');
INSERT INTO "message_reaction" ("message_id", "user_id", "emoji") VALUES
 ('00000001-0000-4000-8000-0000000000d2', '0000000b-0000-4000-8000-000000000003', '👍');
`;

/**
 * The model request a summary of the Trip thread made, which the upgrade keeps
 * as compaction's. Written apart from {@link legacyRows}, so
 * `compare-migrations.ts` can still compare the upgrade with revisions whose
 * migrations stopped at it.
 */
export const legacySummaryRequest = `
INSERT INTO "model_request" ("id", "workspace_id", "purpose", "pod_id", "thread_id", "step", "provider_id", "model", "outcome", "cost_usd", "cost_source", "started_at", "ended_at") VALUES
 ('00000015-0000-4000-8000-0000000000aa', '0000000a-0000-4000-8000-000000000001', 'summary', '0000000d-0000-4000-8000-000000000001', '0000000f-0000-4000-8000-000000000002', 0, '0000000e-0000-4000-8000-000000000000', 'm', 'completed', 0.25, 'provider-reported', '2026-10-05 09:03', '2026-10-05 09:03');
`;

export const legacyFacilitationRequest = `
INSERT INTO "model_request" ("id", "workspace_id", "purpose", "pod_id", "thread_id", "step", "provider_id", "model", "outcome", "cost_usd", "cost_source", "started_at", "ended_at") VALUES
 ('${legacy.facilitationRequest}', '${legacy.workspace}', 'facilitation', '${legacy.pods.family}', '${legacy.threads.trip}', 0, '${legacy.provider}', 'm', 'completed', 0.125, 'provider-reported', '2026-10-05 09:00', '2026-10-05 09:00');
`;

/**
 * More of what `main` holds, written after {@link legacyRows} for
 * `compare-migrations.ts`, so that every statement of the upgrade that moves
 * or rewrites rows finds some: connections shared by a `pod`'s bots, turns
 * waiting on their approvals, a collaboration, files no thread holds, bots
 * whose names clash once they are unique across the workspace, and the
 * records written in the old words.
 */
export const legacyComparisonRows = `
-- Bots: Pat's own Planner, whose name and handle clash with the Family pod's;
-- a bot using the Personal Assistant's handle; a Summariser someone renamed
-- Scribe; and tools switched off by their old names.
INSERT INTO "agent" ("id", "workspace_id", "pod_id", "name", "handle", "color", "face", "model", "disabled_tools", "created_by_id", "created_at") VALUES
 ('0000000c-0000-4000-8000-000000000005', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000003', 'Planner', 'planner', 'rose', 'pill', 'm', '["routines","artifact_read"]', '0000000b-0000-4000-8000-000000000002', '2026-10-03 09:03'),
 ('0000000c-0000-4000-8000-000000000006', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000001', 'Assistant', 'personal-assistant', 'sky', 'dot', 'm', '[]', '0000000b-0000-4000-8000-000000000001', '2026-10-01 09:03');
INSERT INTO "agent" ("id", "workspace_id", "name", "handle", "system_agent_key", "color", "face") VALUES
 ('0000000c-0000-4000-8000-00000000000a', '0000000a-0000-4000-8000-000000000001', 'Scribe', 'scribe', 'summarise', 'rose', 'pill');

-- Connections: the Family pod's Linear, signed in, and its GitHub app.
INSERT INTO "connection" ("id", "workspace_id", "pod_id", "name", "handle", "kind", "url", "auth_kind", "oauth_encrypted", "oauth_state", "tools", "settings", "app_credential_encrypted", "created_by_id", "created_at") VALUES
 ('00000011-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000001', 'Linear', 'linear', 'mcp', 'https://mcp.linear.app/mcp', 'oauth', 'sealed-tokens', 'state-1', '[{"name":"create_issue","readOnly":false},{"name":"list_issues","readOnly":true}]', NULL, NULL, '0000000b-0000-4000-8000-000000000001', '2026-10-02 09:00'),
 ('00000011-0000-4000-8000-000000000002', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000001', 'GitHub', 'github', 'github', 'https://api.github.com', 'header', NULL, NULL, '[]', '{"kind":"github","appId":"1","installationId":"2","owner":{"type":"User","login":"sam"}}', 'sealed-key', '0000000b-0000-4000-8000-000000000001', '2026-10-02 09:01');

-- Routines: Planner's and Budget's started by the GitHub app, Planner's on a
-- schedule, and the Personal Assistant's on one.
INSERT INTO "routine" ("id", "workspace_id", "agent_id", "name", "instructions") VALUES
 ('00000008-0000-4000-8000-000000000003', '0000000a-0000-4000-8000-000000000001', '0000000c-0000-4000-8000-000000000002', 'Triage', 'Triage new issues'),
 ('00000008-0000-4000-8000-000000000004', '0000000a-0000-4000-8000-000000000001', '0000000c-0000-4000-8000-000000000003', 'Morning brief', 'Brief me');
INSERT INTO "routine_trigger" ("id", "workspace_id", "routine_id", "settings", "next_scheduled_at") VALUES
 ('00000010-0000-4000-8000-000000000002', '0000000a-0000-4000-8000-000000000001', '00000008-0000-4000-8000-000000000001', '{"kind":"github","connectionId":"00000011-0000-4000-8000-000000000002","events":["issues"]}', NULL),
 ('00000010-0000-4000-8000-000000000003', '0000000a-0000-4000-8000-000000000001', '00000008-0000-4000-8000-000000000003', '{"kind":"github","connectionId":"00000011-0000-4000-8000-000000000002","events":["issues"]}', NULL),
 ('00000010-0000-4000-8000-000000000004', '0000000a-0000-4000-8000-000000000001', '00000008-0000-4000-8000-000000000001', '{"kind":"cron","cron":"0 9 * * *","timezone":"UTC"}', '2026-12-01 09:00'),
 ('00000010-0000-4000-8000-000000000005', '0000000a-0000-4000-8000-000000000001', '00000008-0000-4000-8000-000000000004', '{"kind":"cron","cron":"0 8 * * *","timezone":"UTC"}', '2026-12-01 08:00');
UPDATE "routine_execution" SET "trigger_kind" = 'cron', "trigger" = '{"kind":"cron","scheduledFor":"2026-10-08T09:00:00Z"}', "trigger_identity" = 'cron-first'
WHERE "id" = '00000009-0000-4000-8000-000000000001';

-- What the running run posted: its trigger's message, and a reply showing
-- the file Planner wrote.
INSERT INTO "message" ("id", "thread_id", "author_user_id", "author_agent_id", "routine_trigger", "routine_execution_id", "kind", "status", "parts", "content", "created_at") VALUES
 ('00000001-0000-4000-8000-000000000101', '0000000f-0000-4000-8000-000000000006', NULL, NULL, '{"kind":"routine_trigger","executionId":"00000009-0000-4000-8000-000000000001","routineName":"Daily digest","triggerKind":"cron"}', '00000009-0000-4000-8000-000000000001', 'text', 'complete', '[]', 'Daily digest', '2026-10-08 09:00'),
 ('00000001-0000-4000-8000-000000000102', '0000000f-0000-4000-8000-000000000006', NULL, '0000000c-0000-4000-8000-000000000001', NULL, NULL, 'text', 'complete', '[{"type":"text","text":"Today:"},{"type":"artifact","artifactId":"00000006-0000-4000-8000-000000000001"}]', 'Today:', '2026-10-08 09:01');

-- Threads of each kind: Budget's channel, a conversation between people,
-- the digest's feed, Compaction's chat for Trip, and a collaboration Planner
-- opened from Trip.
INSERT INTO "thread" ("id", "workspace_id", "pod_id", "host_agent_id", "type", "title", "initiator_user_id", "conversation_id", "routine_id", "system_agent_key", "parent_thread_id", "created_at") VALUES
 ('0000000f-0000-4000-8000-000000000008', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000001', '0000000c-0000-4000-8000-000000000002', 'bot_channel', 'Budget', NULL, '0000000f-0000-4000-8000-000000000008', NULL, NULL, NULL, '2026-10-05 11:00'),
 ('0000000f-0000-4000-8000-000000000009', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000001', NULL, 'conversation', 'Sam and Pat', '0000000b-0000-4000-8000-000000000001', '0000000f-0000-4000-8000-000000000009', NULL, NULL, NULL, '2026-10-05 12:00'),
 ('0000000f-0000-4000-8000-00000000000a', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000001', '0000000c-0000-4000-8000-000000000001', 'routine_feed', 'Daily digest', NULL, '0000000f-0000-4000-8000-00000000000a', '00000008-0000-4000-8000-000000000001', NULL, NULL, '2026-10-05 13:00'),
 ('0000000f-0000-4000-8000-00000000000b', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000001', '0000000c-0000-4000-8000-000000000009', 'system_agent', 'Compaction', NULL, '0000000f-0000-4000-8000-00000000000b', NULL, 'compaction', '0000000f-0000-4000-8000-000000000002', '2026-10-05 14:00'),
 ('0000000f-0000-4000-8000-00000000000c', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000001', '0000000c-0000-4000-8000-000000000002', 'collaboration', 'Check the budget', NULL, '0000000f-0000-4000-8000-000000000002', NULL, NULL, '0000000f-0000-4000-8000-000000000002', '2026-10-05 09:03');

-- In Trip: Planner asking Budget, in a reply with text around its card and
-- in one with nothing but a card; Budget answering in the collaboration;
-- Planner's hand-back; and two of Budget's turns waiting on approvals, one
-- for Linear and one for the GitHub app.
INSERT INTO "message" ("id", "thread_id", "author_user_id", "author_agent_id", "kind", "status", "parts", "content", "turn_id", "created_at") VALUES
 ('00000001-0000-4000-8000-000000000103', '0000000f-0000-4000-8000-000000000002', NULL, '0000000c-0000-4000-8000-000000000001', 'text', 'complete', '[{"type":"text","text":"Asking "},{"type":"collaboration","collaborationId":"00000012-0000-4000-8000-000000000001"},{"type":"text","text":"now."}]', 'Asking now.', '00000002-0000-4000-8000-000000000001', '2026-10-05 09:03'),
 ('00000001-0000-4000-8000-000000000104', '0000000f-0000-4000-8000-000000000002', NULL, '0000000c-0000-4000-8000-000000000001', 'text', 'complete', '[{"type":"collaboration","collaborationId":"00000012-0000-4000-8000-000000000001"}]', '', '00000002-0000-4000-8000-000000000001', '2026-10-05 09:04'),
 ('00000001-0000-4000-8000-000000000105', '0000000f-0000-4000-8000-00000000000c', NULL, '0000000c-0000-4000-8000-000000000001', 'text', 'complete', '[{"type":"text","text":"Check the budget"}]', 'Check the budget', NULL, '2026-10-05 09:03'),
 ('00000001-0000-4000-8000-000000000107', '0000000f-0000-4000-8000-000000000002', '0000000b-0000-4000-8000-000000000001', NULL, 'text', 'complete', '[{"type":"text","text":"Budget, file it"}]', 'Budget, file it', NULL, '2026-10-05 09:10'),
 ('00000001-0000-4000-8000-000000000109', '0000000f-0000-4000-8000-000000000002', '0000000b-0000-4000-8000-000000000001', NULL, 'text', 'complete', '[{"type":"text","text":"Budget, tidy the comments"}]', 'Budget, tidy the comments', NULL, '2026-10-05 09:12');
INSERT INTO "turn" ("id", "thread_id", "agent_id", "trigger_message_id", "status", "model", "reason", "checkpoint", "started_at", "finished_at") VALUES
 ('00000002-0000-4000-8000-000000000103', '0000000f-0000-4000-8000-00000000000c', '0000000c-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000105', 'done', 'm', 'collaboration', NULL, '2026-10-05 09:03', '2026-10-05 09:04'),
 ('00000002-0000-4000-8000-000000000104', '0000000f-0000-4000-8000-000000000002', '0000000c-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000104', 'done', 'm', 'resume', NULL, '2026-10-05 09:05', '2026-10-05 09:06'),
 ('00000002-0000-4000-8000-000000000105', '0000000f-0000-4000-8000-000000000002', '0000000c-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000107', 'waiting', 'm', 'mention', '{"approvals":[{"toolCallId":"00000003-0000-4000-8000-000000000105","connectionId":"00000011-0000-4000-8000-000000000001","connectionRevision":1}]}', '2026-10-05 09:10', NULL),
 ('00000002-0000-4000-8000-000000000106', '0000000f-0000-4000-8000-000000000002', '0000000c-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000109', 'waiting', 'm', 'mention', '{"approvals":[{"toolCallId":"00000003-0000-4000-8000-000000000106","connectionId":"00000011-0000-4000-8000-000000000002","connectionRevision":1}]}', '2026-10-05 09:12', NULL);
INSERT INTO "message" ("id", "thread_id", "author_agent_id", "kind", "status", "parts", "content", "turn_id", "created_at") VALUES
 ('00000001-0000-4000-8000-000000000106', '0000000f-0000-4000-8000-00000000000c', '0000000c-0000-4000-8000-000000000002', 'text', 'complete', '[{"type":"text","text":"Within budget."}]', 'Within budget.', '00000002-0000-4000-8000-000000000103', '2026-10-05 09:04'),
 ('00000001-0000-4000-8000-000000000108', '0000000f-0000-4000-8000-000000000002', '0000000c-0000-4000-8000-000000000002', 'text', 'streaming', '[]', '', '00000002-0000-4000-8000-000000000105', '2026-10-05 09:10'),
 ('00000001-0000-4000-8000-00000000010a', '0000000f-0000-4000-8000-000000000002', '0000000c-0000-4000-8000-000000000002', 'text', 'streaming', '[]', '', '00000002-0000-4000-8000-000000000106', '2026-10-05 09:12');
INSERT INTO "collaboration" ("id", "parent_thread_id", "parent_message_id", "turn_id", "child_thread_id", "collaborator_agent_id", "brief", "status", "answer", "at_offset") VALUES
 ('00000012-0000-4000-8000-000000000001', '0000000f-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000103', '00000002-0000-4000-8000-000000000001', '0000000f-0000-4000-8000-00000000000c', '0000000c-0000-4000-8000-000000000002', 'Check the budget', 'done', 'Within budget.', 6);
INSERT INTO "tool_call" ("id", "thread_id", "message_id", "turn_id", "tool", "sdk_tool_call_id", "input", "output", "status", "approval_id", "approval_status", "connection_id", "connection_revision", "remote_tool_name", "mutating", "at_offset", "started_at", "updated_at") VALUES
 ('00000003-0000-4000-8000-000000000105', '0000000f-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000108', '00000002-0000-4000-8000-000000000105', 'linear__create_issue', 'sdk-105', '{"title":"Trip"}', NULL, 'awaiting_approval', 'approval-105', 'pending', '00000011-0000-4000-8000-000000000001', 1, 'create_issue', true, 0, '2026-10-05 09:10', '2026-10-05 09:11'),
 ('00000003-0000-4000-8000-000000000106', '0000000f-0000-4000-8000-000000000002', '00000001-0000-4000-8000-00000000010a', '00000002-0000-4000-8000-000000000106', 'github__delete_comment', 'sdk-106', '{"id":1}', NULL, 'awaiting_approval', 'approval-106', 'pending', '00000011-0000-4000-8000-000000000002', 1, 'delete_comment', true, 0, '2026-10-05 09:12', '2026-10-05 09:12'),
 ('00000003-0000-4000-8000-000000000107', '0000000f-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000002', '00000002-0000-4000-8000-000000000001', 'linear__create_issue', 'sdk-107', '{"title":"Hotel"}', '{"ok":true}', 'completed', 'approval-107', 'allowed', '00000011-0000-4000-8000-000000000001', 1, 'create_issue', true, 1, '2026-10-05 09:01', '2026-10-05 09:02'),
 ('00000003-0000-4000-8000-000000000108', '0000000f-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000002', '00000002-0000-4000-8000-000000000001', 'request_network_access', 'sdk-108', '{"host":"example.org"}', '{"granted":true}', 'completed', 'approval-108', 'allowed', NULL, NULL, NULL, false, 2, '2026-10-05 09:01', '2026-10-05 09:02'),
 ('00000003-0000-4000-8000-000000000109', '0000000f-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000002', '00000002-0000-4000-8000-000000000001', 'artifact_write', 'sdk-109', '{"artifactId":"00000006-0000-4000-8000-000000000001","content":"# Itinerary"}', '{"artifactId":"00000006-0000-4000-8000-000000000001","artifacts":[]}', 'completed', NULL, NULL, NULL, NULL, NULL, true, 3, '2026-10-05 09:01', '2026-10-05 09:02');
INSERT INTO "lane" ("key", "subject", "state", "workflow", "execution_id", "payload") VALUES
 ('turn:0000000f-0000-4000-8000-00000000000c:0000000c-0000-4000-8000-000000000002', '0000000f-0000-4000-8000-00000000000c', 'idle', NULL, NULL, NULL),
 ('turn:0000000f-0000-4000-8000-000000000002:0000000c-0000-4000-8000-000000000002', '0000000f-0000-4000-8000-000000000002', 'running', 'turn', 'execution-budget', '{"threadId":"0000000f-0000-4000-8000-000000000002","agentId":"0000000c-0000-4000-8000-000000000002","triggerMessageId":"00000001-0000-4000-8000-000000000107","reason":"resume"}');
UPDATE "turn" SET "owner" = 'execution-budget' WHERE "id" = '00000002-0000-4000-8000-000000000105';

-- Trip's compaction, summary and reads, a reaction, and events kept for
-- reconnecting clients.
INSERT INTO "thread_compaction" ("thread_id", "summary", "history_starts_at", "kept_from") VALUES
 ('0000000f-0000-4000-8000-000000000002', 'Planned a trip.', '2026-10-05 09:00', '2026-10-05 09:01');
INSERT INTO "thread_summary" ("thread_id", "content", "source_message_id") VALUES
 ('0000000f-0000-4000-8000-000000000002', 'A trip.', '00000001-0000-4000-8000-000000000002');
INSERT INTO "thread_read" ("thread_id", "user_id", "read_through") VALUES
 ('0000000f-0000-4000-8000-000000000002', '0000000b-0000-4000-8000-000000000001', '2026-10-05 09:02');
INSERT INTO "message_reaction" ("message_id", "user_id", "emoji") VALUES
 ('00000001-0000-4000-8000-000000000002', '0000000b-0000-4000-8000-000000000002', '🎉');
INSERT INTO "event" ("channel", "type", "payload") VALUES
 ('workspace:0000000a-0000-4000-8000-000000000001', 'pod.updated', '{"type":"pod.updated","podId":"0000000d-0000-4000-8000-000000000001"}'),
 ('thread:0000000f-0000-4000-8000-000000000002', 'tool_call.updated', '{"type":"tool_call.updated","toolCall":{"approval":{"deciders":"pod"}}}');

-- Files no thread holds: the Notes pod's, which has no main chat, and one in
-- Pat's personal pod, by Helper.
INSERT INTO "artifact" ("id", "workspace_id", "pod_id", "kind", "title", "current_version", "created_by_agent_id", "created_in_thread_id") VALUES
 ('00000006-0000-4000-8000-000000000002', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000002', 'document', 'Notes', 1, NULL, NULL),
 ('00000006-0000-4000-8000-000000000003', '0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000003', 'html', 'Chart', 1, '0000000c-0000-4000-8000-000000000004', NULL);
INSERT INTO "artifact_version" ("id", "artifact_id", "number", "content_type", "size") VALUES
 ('00000007-0000-4000-8000-000000000002', '00000006-0000-4000-8000-000000000002', 1, 'text/markdown', 5),
 ('00000007-0000-4000-8000-000000000003', '00000006-0000-4000-8000-000000000003', 1, 'text/html', 5);

-- Computers: hosts the pods allowed, Family's measured disk and a viewer's
-- lease, and the provider's settings in the old words.
INSERT INTO "sandbox_pod_allowed_host" ("workspace_id", "pod_id", "host", "added_by_id") VALUES
 ('0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000001', 'example.com', '0000000b-0000-4000-8000-000000000001'),
 ('0000000a-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000003', 'pat.example.com', '0000000b-0000-4000-8000-000000000002');
UPDATE "sandbox" SET "disk_usage" = '{"folders":[{"agentId":"0000000c-0000-4000-8000-000000000001","bytes":10},{"path":"cache","bytes":2}]}', "disk_measured_at" = '2026-10-08 09:00'
WHERE "id" = '00000005-0000-4000-8000-000000000001';
INSERT INTO "sandbox_lease" ("sandbox_id", "holder_kind", "holder_id", "expires_at") VALUES
 ('00000005-0000-4000-8000-000000000001', 'viewer', 'viewer-1', '2026-12-01 09:00');
UPDATE "sandbox_provider" SET "settings" = "settings" || '{"networkMode":"allowlist"}', "managed_resources" = '{"preset":"opensandbox","templates":[]}';

-- Models: a provider signed in by Sam, a model that reasons, and requests of
-- each purpose since renamed or gone.
INSERT INTO "model_provider" ("id", "workspace_id", "name", "base_url", "api_format", "oauth_tokens_encrypted", "connected_by_id", "created_by_id") VALUES
 ('00000013-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000001', 'Anthropic', 'https://api.anthropic.com', 'anthropic', 'sealed-tokens', '0000000b-0000-4000-8000-000000000001', '0000000b-0000-4000-8000-000000000001');
INSERT INTO "provider_model" ("id", "workspace_id", "provider_id", "model_id", "capabilities", "disabled_capabilities", "source") VALUES
 ('00000014-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000001', '00000013-0000-4000-8000-000000000001', 'm', '["tools","reasoning"]', '["reasoning"]', 'catalog');
INSERT INTO "model_request" ("id", "workspace_id", "purpose", "pod_id", "agent_id", "thread_id", "turn_id", "step", "provider_id", "model", "outcome", "started_at", "ended_at") VALUES
 ('00000015-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000001', 'agent-turn', '0000000d-0000-4000-8000-000000000003', '0000000c-0000-4000-8000-000000000003', '0000000f-0000-4000-8000-000000000005', NULL, 0, '00000013-0000-4000-8000-000000000001', 'm', 'completed', '2026-10-07 09:01', '2026-10-07 09:02'),
 ('00000015-0000-4000-8000-000000000002', '0000000a-0000-4000-8000-000000000001', 'agent-turn', '0000000d-0000-4000-8000-000000000001', '0000000c-0000-4000-8000-000000000002', '0000000f-0000-4000-8000-00000000000c', '00000002-0000-4000-8000-000000000103', 0, '00000013-0000-4000-8000-000000000001', 'm', 'completed', '2026-10-05 09:03', '2026-10-05 09:04'),
 ('00000015-0000-4000-8000-000000000004', '0000000a-0000-4000-8000-000000000001', 'trial', NULL, NULL, NULL, NULL, 0, '00000013-0000-4000-8000-000000000001', 'm', 'failed', '2026-10-01 09:00', '2026-10-01 09:00');

${legacyFacilitationRequest}

-- People: an invitation and notification settings in the old words.
INSERT INTO "workspace_invite" ("workspace_id", "email", "role", "inviter_id", "expires_at") VALUES
 ('0000000a-0000-4000-8000-000000000001', 'lee@example.com', 'member', '0000000b-0000-4000-8000-000000000001', '2026-12-01 09:00');
INSERT INTO "notification_override" ("user_id", "pod_id", "level") VALUES
 ('0000000b-0000-4000-8000-000000000001', '0000000d-0000-4000-8000-000000000001', 'mentions');
INSERT INTO "notification_settings" ("user_id", "level", "routine_runs") VALUES
 ('0000000b-0000-4000-8000-000000000001', 'all', 'all');
`;

/** The token of the session main gave `memberId`, in {@link legacySessions}. */
export function legacySessionToken(memberId: string): string {
	return `session-${memberId}`;
}

/** A session for each member, signed in on main, which the upgrade keeps. */
export const legacySessions = `
INSERT INTO "session" ("token", "user_id", "expires_at") VALUES
${Object.values(legacy.members)
	.map((member) => ` ('${legacySessionToken(member)}', '${member}', now() + interval '1 day')`)
	.join(",\n")};
`;

export const legacyMigrationScaleRows = `
-- A workspace whose General chat has nobody to credit.
INSERT INTO "workspace" ("id", "name", "slug")
VALUES ('${migrationScale.memberlessWorkspace}', 'Empty', 'empty');
INSERT INTO "pod" ("id", "workspace_id", "kind", "name", "slug")
VALUES ('${migrationScale.memberlessPod}', '${migrationScale.memberlessWorkspace}', 'shared', 'Empty', 'empty');
INSERT INTO "thread" ("id", "workspace_id", "pod_id", "type", "main", "title", "conversation_id")
VALUES ('${migrationScale.memberlessGeneral}', '${migrationScale.memberlessWorkspace}', '${migrationScale.memberlessPod}', 'pod_chat', true, 'General', '${migrationScale.memberlessGeneral}');

-- The asking bot's deletion takes the collaboration record with it.
INSERT INTO "thread" ("id", "workspace_id", "pod_id", "host_agent_id", "type", "title", "conversation_id", "parent_thread_id") VALUES
 ('${migrationScale.orphanedCollaboration}', '${legacy.workspace}', '${legacy.pods.family}', '${legacy.bots.budget}', 'collaboration', 'Budget', '${legacy.threads.trip}', '${legacy.threads.trip}'),
 ('${migrationScale.hostlessPersonalChat}', '${legacy.workspace}', '0000000d-0000-4000-8000-000000000003', NULL, 'conversation', 'Files', '${migrationScale.hostlessPersonalChat}', NULL);
INSERT INTO "agent" ("id", "workspace_id", "pod_id", "name", "handle", "color", "face")
VALUES ('${askingBot}', '${legacy.workspace}', '${legacy.pods.family}', 'Travel', 'travel', 'sky', 'dot');
INSERT INTO "turn" ("id", "thread_id", "agent_id", "trigger_message_id", "status", "model", "reason", "started_at", "finished_at")
VALUES ('${askingTurn}', '${legacy.threads.trip}', '${askingBot}', '${legacy.tripMessages.asked}', 'done', 'm', 'mention', '2026-10-05 09:03', '2026-10-05 09:06');
INSERT INTO "message" ("id", "thread_id", "author_agent_id", "kind", "status", "parts", "content") VALUES
 ('${askingReply}', '${legacy.threads.trip}', '${askingBot}', 'text', 'complete', '[]', ''),
 ('${migrationScale.collaborationReply}', '${migrationScale.orphanedCollaboration}', '${legacy.bots.budget}', 'text', 'complete', '[{"type":"text","text":"The budget is ready."}]', 'The budget is ready.');
INSERT INTO "collaboration" ("parent_thread_id", "parent_message_id", "turn_id", "child_thread_id", "collaborator_agent_id", "brief", "status", "answer", "at_offset")
VALUES ('${legacy.threads.trip}', '${askingReply}', '${askingTurn}', '${migrationScale.orphanedCollaboration}', '${legacy.bots.budget}', 'Check the budget', 'done', 'The budget is ready.', 0);
INSERT INTO "thread_file" ("id", "thread_id", "kind", "name", "content_type", "size", "message_id", "position")
VALUES ('${migrationScale.files.collaborationAttachment.fileId}', '${migrationScale.orphanedCollaboration}', 'agent_attachment', 'budget.txt', 'text/plain', ${migrationScale.files.collaborationAttachment.text.length}, '${migrationScale.collaborationReply}', 0);
INSERT INTO "artifact" ("id", "workspace_id", "pod_id", "kind", "title", "current_version", "created_by_agent_id", "created_in_thread_id") VALUES
 ('${migrationScale.files.collaboration.fileId}', '${legacy.workspace}', '${legacy.pods.family}', 'document', 'Budget', 1, '${legacy.bots.budget}', '${migrationScale.orphanedCollaboration}'),
 ('${migrationScale.files.personal.fileId}', '${legacy.workspace}', '0000000d-0000-4000-8000-000000000003', 'document', 'Personal notes', 1, '${legacy.bots.helper}', '${migrationScale.hostlessPersonalChat}');
INSERT INTO "artifact_version" ("id", "artifact_id", "number", "content_type", "size") VALUES
 ('${migrationScale.files.collaboration.versionId}', '${migrationScale.files.collaboration.fileId}', 1, 'text/markdown', ${migrationScale.files.collaboration.text.length}),
 ('${migrationScale.files.personal.versionId}', '${migrationScale.files.personal.fileId}', 1, 'text/markdown', ${migrationScale.files.personal.text.length});
DELETE FROM "agent" WHERE "id" = '${askingBot}';
UPDATE "agent" SET "created_by_id" = NULL WHERE "id" = '${legacy.bots.helper}';
INSERT INTO "model_request" ("id", "workspace_id", "purpose", "step", "provider_id", "model", "outcome", "started_at", "ended_at", "cost_usd", "cost_source")
VALUES ('${migrationScale.unattributedRequest}', '${legacy.workspace}', 'agent-turn', 0, '${legacy.provider}', 'm', 'completed', '2026-10-05 09:01', '2026-10-05 09:02', 0.5, 'provider-reported');

INSERT INTO "agent" ("id", "workspace_id", "pod_id", "name", "handle", "color", "face")
VALUES ('${migrationScale.reservedBot}', '${legacy.workspace}', '${legacy.pods.family}', 'Digest', 'personal-assistant', 'sky', 'dot');

-- A queued run whose lane went away, and a finished run that posted to two chats.
INSERT INTO "thread" ("id", "workspace_id", "pod_id", "host_agent_id", "type", "title", "conversation_id") VALUES
 ('0000000f-0000-4000-8000-000000000023', '${legacy.workspace}', '${legacy.pods.family}', '${legacy.bots.planner}', 'routine', 'Daily digest', '0000000f-0000-4000-8000-000000000023'),
 ('0000000f-0000-4000-8000-000000000024', '${legacy.workspace}', '${legacy.pods.family}', '${legacy.bots.planner}', 'routine', 'Daily digest', '0000000f-0000-4000-8000-000000000024');
INSERT INTO "thread" ("id", "workspace_id", "pod_id", "host_agent_id", "type", "title", "conversation_id", "routine_id")
VALUES ('${migrationScale.feed}', '${legacy.workspace}', '${legacy.pods.family}', '${legacy.bots.planner}', 'routine_feed', 'Daily digest', '${migrationScale.feed}', '${legacy.routine}');
INSERT INTO "routine_execution" ("id", "routine_id", "workspace_id", "agent_id", "thread_id", "trigger_kind", "trigger_identity", "trigger", "routine_name", "instructions", "state", "started_at", "finished_at") VALUES
 ('${migrationScale.unclaimedRun}', '${legacy.routine}', '${legacy.workspace}', '${legacy.bots.planner}', '0000000f-0000-4000-8000-000000000023', 'manual', 'unclaimed', '{"kind":"manual"}', 'Daily digest', 'Sum up the day', 'queued', NULL, NULL),
 ('${migrationScale.resultRun}', '${legacy.routine}', '${legacy.workspace}', '${legacy.bots.planner}', '0000000f-0000-4000-8000-000000000024', 'manual', 'result', '{"kind":"manual"}', 'Daily digest', 'Sum up the day', 'completed', '2026-10-09 09:00', '2026-10-09 09:01');
UPDATE "routine" SET "results" = 'post_to_chat', "chat_id" = '${legacy.threads.trip}' WHERE "id" = '${legacy.routine}';
INSERT INTO "message" ("id", "thread_id", "author_agent_id", "routine_execution_id", "kind", "status", "parts", "content", "created_at") VALUES
 ('${migrationScale.feedResult}', '${migrationScale.feed}', '${legacy.bots.planner}', '${migrationScale.resultRun}', 'text', 'complete', '[{"type":"text","text":"Digest ready."}]', 'Digest ready.', '2026-10-09 09:02'),
 ('${migrationScale.chatResult}', '${legacy.threads.trip}', '${legacy.bots.planner}', '${migrationScale.resultRun}', 'text', 'complete', '[{"type":"text","text":"Digest ready."}]', 'Digest ready.', '2026-10-09 09:01');

-- The reply and read must go with the direct chat.
INSERT INTO "message" ("thread_id", "author_user_id", "reply_to_message_id", "kind", "status", "parts", "content")
VALUES ('${legacy.directMessages.samAndPat}', '${legacy.members.pat}', '00000001-0000-4000-8000-0000000000d1', 'text', 'complete', '[]', 'Got the tickets.');
`;

export const legacyCyclicCollaboration = `
INSERT INTO "thread" ("id", "workspace_id", "pod_id", "host_agent_id", "type", "title", "conversation_id", "parent_thread_id")
VALUES ('${migrationScale.cyclicChat}', '${legacy.workspace}', '${legacy.pods.family}', '${legacy.bots.budget}', 'collaboration', 'Budget', '${legacy.threads.trip}', '${migrationScale.cyclicChat}');
INSERT INTO "collaboration" ("parent_thread_id", "parent_message_id", "turn_id", "child_thread_id", "collaborator_agent_id", "brief", "status", "at_offset")
VALUES ('${migrationScale.cyclicChat}', '${legacy.tripMessages.answered}', '00000002-0000-4000-8000-000000000001', '${migrationScale.cyclicChat}', '${legacy.bots.budget}', 'Check the budget', 'done', 0);
`;
