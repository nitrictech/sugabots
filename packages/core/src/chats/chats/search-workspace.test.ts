import { sql } from "drizzle-orm";
import { Effect } from "effect";
import { SqlClient, Statement } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { seedProjectChat } from "../../authentication/seed.test-support.ts";
import { query, type RunEffect, transaction } from "../../database/database.ts";
import { copyTestDatabase } from "../../database/test-setup.ts";
import {
	closeDatabase,
	onDatabase,
	runOnPostgres,
	type TestInfrastructure,
} from "../../database/testing.ts";
import { asMember } from "../../operations/chats/testing.ts";
import {
	type CallOperation,
	operationsForTests,
	servedOperations,
} from "../../operations/testing.ts";
import type { BotPrincipal, MemberSession } from "../../principal.ts";
import { chatServicesForTests } from "../testing.ts";
import { aChatAwaitingReply, openTurn, runningTurns, runOver } from "../turns/testing.ts";

const UNRELATED_MATCHES = 10_000;

const messagesRead = query((db) =>
	db.execute<{ read: string }>(
		sql`
		select seq_tup_read + idx_tup_fetch as read
		from pg_stat_xact_user_tables
		where schemaname = 'public' and relname = 'message'
	`,
		"objects",
	),
).pipe(Effect.map(([row]) => Number(row?.read ?? 0)));

const withBoundedMessageReads: RunEffect<TestInfrastructure> = (effect) =>
	runOnPostgres(
		transaction(
			Effect.gen(function* () {
				const before = yield* messagesRead;
				const messageQueries: ReturnType<Statement.Statement<unknown>["compile"]>[] = [];
				const result = yield* Effect.provideService(
					effect,
					Statement.CurrentTransformer,
					(statement) => {
						const compiled = statement.compile();
						if (/\b(?:from|join)\s+"?message"?\b/i.test(compiled[0])) {
							messageQueries.push(compiled);
						}
						return Effect.succeed(statement);
					},
				);
				const reads = (yield* messagesRead) - before;
				const budget = UNRELATED_MATCHES / 10;
				if (reads >= budget) {
					const client = yield* SqlClient.SqlClient;
					const plans = yield* Effect.all(
						messageQueries.map(([queryText, params]) =>
							client.unsafe<{ "QUERY PLAN": string }>(
								`explain (analyze, buffers, timing off) ${queryText}`,
								params,
							),
						),
					);
					const formatted = plans.map((plan) => plan.map((row) => row["QUERY PLAN"]).join("\n"));
					throw new Error(
						`Read ${reads} message rows, expected fewer than ${budget}\n${formatted.join("\n\n")}`,
					);
				}
				return result;
			}),
		),
	);

describe.skipIf(!process.env.DATABASE_URL)("matching messages within the reached workspace", () => {
	let call: CallOperation;
	let member: MemberSession;
	let acting: BotPrincipal;
	let workspaceId: string;
	let targetChat: string;
	let after: string;
	let database: Awaited<ReturnType<typeof copyTestDatabase>> | undefined;

	beforeAll(async () => {
		const template = inject("testDatabaseTemplateUrl");
		if (!template) throw new Error("Expected a test database template");
		database = await copyTestDatabase(template, "search_workspace");
		vi.stubEnv("DATABASE_URL", database.url);

		const chats = await chatServicesForTests({ publishCommitted: () => Promise.resolve() });
		const fixtures = await servedOperations({ chats });
		const chatsAs = (memberId: string) => asMember(fixtures, memberId);
		const reached = await aChatAwaitingReply(chatsAs);
		const unrelated = await aChatAwaitingReply(chatsAs);
		workspaceId = reached.workspaceId;
		member = await chatsAs(reached.adminId).principal();
		targetChat = await seedProjectChat(workspaceId, reached.projectId, reached.adminId);

		const now = new Date();
		after = new Date(now.getTime() - 60_000).toISOString();
		await onDatabase((db) =>
			db.execute(
				sql`
			insert into message (chat_id, author_bot_id, status, parts, content, created_at)
			select ${targetChat}::uuid, ${reached.botId}::uuid, 'complete', '[]'::jsonb,
				'@sam freight ready', ${now.toISOString()}::timestamptz
			union all
			select ${targetChat}::uuid, ${reached.botId}::uuid, 'complete', '[]'::jsonb,
				'freight needs booking', ${after}::timestamptz - interval '1 second'
			union all
			select ${unrelated.chatId}::uuid, ${unrelated.botId}::uuid, 'complete', '[]'::jsonb,
				'@sam freight scheduled ' || ordinal, ${now.toISOString()}::timestamptz
			from generate_series(1, ${UNRELATED_MATCHES}::int) as ordinal
		`,
				"objects",
			),
		);
		await onDatabase((db) => db.execute(sql`analyze message`, "objects"));

		const [run] = await runOnPostgres(runningTurns(reached.chatId));
		if (!run) throw new Error("The chat has no turn");
		({ principal: acting } = await runOver(chats)(openTurn(run)));
		const operations = await operationsForTests({ chats });
		call = (principal, name, input) =>
			withBoundedMessageReads(operations[name](principal, input, { kind: "request" }));
	}, 30_000);

	afterAll(async () => {
		try {
			await closeDatabase();
			await database?.drop();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("counts unread mentions without reading matches from unrelated chats", async () => {
		expect(await call(member, "chats.attention", { workspace: workspaceId })).toMatchObject({
			unreadForYou: 1,
		});
	});

	it("searches reached chats within its time range without reading unrelated matches", async () => {
		expect(
			await call(acting, "chats.searchHistory", { chat: "all", query: "freight", after }),
		).toEqual({
			messages: [expect.objectContaining({ chatId: targetChat, text: "@sam freight ready" })],
			more: false,
		});
	});
});
