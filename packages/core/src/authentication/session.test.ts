import { memberStream, streamEvent } from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query, transaction } from "../database/database.ts";
import { EventBus } from "../database/events/bus.ts";
import { EventOutbox } from "../database/events/outbox.ts";
import { postgresEventRelay } from "../database/events/relay.ts";
import { EventStore } from "../database/events/store.ts";
import { session } from "../database/schema.ts";
import { closeDatabase, databaseForTests, onDatabase, runOnPostgres } from "../database/testing.ts";
import { seedMember, seedSession, seedWorkspace } from "./seed.test-support.ts";
import { type CookieSession, expiryOf, SessionAuthentication } from "./session.ts";

/** `Methods` with better-auth's reading of each request's cookie already given. */
type WithCookie<Methods> = {
	readonly [Name in keyof Methods]: Methods[Name] extends (
		headers: Headers,
	) => Effect.Effect<infer A, infer E, SessionAuthentication.Cookies>
		? (headers: Headers) => Effect.Effect<A, E>
		: never;
};

describe("SessionAuthentication", () => {
	/** What better-auth's cookie, or its cookie cache, says the request carries. */
	let cookie: CookieSession | undefined;
	let auth: WithCookie<SessionAuthentication.Interface>;
	let workspaceId: string;

	beforeAll(async () => {
		const service = await runOnPostgres(
			Effect.provide(SessionAuthentication.Service, SessionAuthentication.layer),
		);
		const withCookie = Effect.provideService(SessionAuthentication.Cookies, {
			read: () => Effect.sync(() => cookie),
		});
		auth = {
			authenticate: (headers) => withCookie(service.authenticate(headers)),
		};
		workspaceId = await seedWorkspace();
	});

	afterAll(async () => {
		await closeDatabase();
	});

	const bearer = (token: string) => new Headers({ authorization: `Bearer ${token}` });

	it("authenticates a bearer token as its session's member, with the session's id", async () => {
		cookie = undefined;
		const memberId = await seedMember(workspaceId, "editor");
		const signedIn = await seedSession(memberId);

		const principal = await runOnPostgres(auth.authenticate(bearer(signedIn.token)));

		expect(principal._tag).toBe("MemberSession");
		expect(principal.member).toBe(memberId);
		expect(principal.session).toBe(signedIn.id);
	});

	it("refuses a bearer token that is expired or names no session, even with a good cookie", async () => {
		const memberId = await seedMember(workspaceId, "editor");
		const expired = await seedSession(memberId, -60);
		const good = await seedSession(memberId);
		cookie = { session: good.id, member: memberId };

		await expect(runOnPostgres(auth.authenticate(bearer(expired.token)))).rejects.toBeInstanceOf(
			SessionAuthentication.SessionInvalid,
		);
		await expect(
			runOnPostgres(auth.authenticate(bearer("token-nobody-has"))),
		).rejects.toBeInstanceOf(SessionAuthentication.SessionInvalid);
	});

	it("uses the same expiry boundary for bearer, cookie and session rechecks", async () => {
		const memberId = await seedMember(workspaceId, "editor");
		const signedIn = await seedSession(memberId);
		const expiresAt = Date.UTC(2030, 0, 1);
		await onDatabase((db) =>
			db
				.update(session)
				.set({ expiresAt: new Date(expiresAt) })
				.where(eq(session.id, signedIn.id)),
		);
		cookie = { session: signedIn.id, member: memberId };

		const results = await runOnPostgres(
			Effect.gen(function* () {
				yield* TestClock.setTime(expiresAt - 1);
				const principal = yield* auth.authenticate(bearer(signedIn.token));
				const before = yield* expiryOf(principal);
				yield* TestClock.adjust(1);
				const bearerAtExpiry = yield* Effect.result(auth.authenticate(bearer(signedIn.token)));
				const cookieAtExpiry = yield* Effect.result(auth.authenticate(new Headers()));
				const recheckAtExpiry = yield* expiryOf(principal);
				return { before, bearerAtExpiry, cookieAtExpiry, recheckAtExpiry };
			}).pipe(Effect.provide(TestClock.layer())),
		);

		expect(results.before).toEqual(new Date(expiresAt));
		expect(results.bearerAtExpiry).toMatchObject({
			_tag: "Failure",
			failure: { _tag: "SessionInvalid" },
		});
		expect(results.cookieAtExpiry).toMatchObject({
			_tag: "Failure",
			failure: { _tag: "SessionInvalid" },
		});
		expect(results.recheckAtExpiry).toBeUndefined();
	});

	it("takes better-auth's reading of the cookie for an ordinary request", async () => {
		const memberId = await seedMember(workspaceId, "viewer");
		const signedIn = await seedSession(memberId);
		cookie = { session: signedIn.id, member: memberId };

		const principal = await runOnPostgres(auth.authenticate(new Headers()));

		expect(principal.member).toBe(memberId);
		expect(principal.session).toBe(signedIn.id);
	});

	it("refuses a new request after its cached session was revoked", async () => {
		const memberId = await seedMember(workspaceId, "editor");
		const signedIn = await seedSession(memberId);
		cookie = { session: signedIn.id, member: memberId };

		expect((await runOnPostgres(auth.authenticate(new Headers()))).session).toBe(signedIn.id);
		await onDatabase((db) => db.delete(session).where(eq(session.id, signedIn.id)));

		await expect(runOnPostgres(auth.authenticate(new Headers()))).rejects.toBeInstanceOf(
			SessionAuthentication.SessionInvalid,
		);
	});

	it("refuses a request with neither a good cookie nor a bearer token", async () => {
		cookie = undefined;

		await expect(runOnPostgres(auth.authenticate(new Headers()))).rejects.toBeInstanceOf(
			SessionAuthentication.SessionInvalid,
		);
		await expect(
			runOnPostgres(auth.authenticate(new Headers({ authorization: "Basic abc" }))),
		).rejects.toBeInstanceOf(SessionAuthentication.SessionInvalid);
	});

	it("refuses a request whose session expired, or whose cookie names another member", async () => {
		const memberId = await seedMember(workspaceId, "editor");
		const otherId = await seedMember(workspaceId, "editor");
		const expired = await seedSession(memberId, -60);
		const good = await seedSession(memberId);

		cookie = { session: expired.id, member: memberId };
		await expect(runOnPostgres(auth.authenticate(new Headers()))).rejects.toBeInstanceOf(
			SessionAuthentication.SessionInvalid,
		);

		cookie = { session: good.id, member: otherId };
		await expect(runOnPostgres(auth.authenticate(new Headers()))).rejects.toBeInstanceOf(
			SessionAuthentication.SessionInvalid,
		);
	});

	it("tells the member's streams, in every process, once a session is deleted", async () => {
		const memberId = await seedMember(workspaceId, "editor");
		const signedIn = await seedSession(memberId);
		const store = await runOnPostgres(EventStore.make);
		const relay = await databaseForTests.runPromise(postgresEventRelay(store));
		let listening: Promise<unknown> = Promise.resolve();
		const bus = EventBus.inProcess({
			relay: {
				broadcast: relay.broadcast,
				listen: (receive) => {
					const stop = relay.listen(receive);
					listening = stop;
					return stop;
				},
			},
		});
		const stop = new AbortController();
		try {
			await listening;
			const deliveries = bus.subscribe(memberStream(memberId), { signal: stop.signal });

			await onDatabase((db) => db.delete(session).where(eq(session.id, signedIn.id)));

			const { value } = await deliveries[Symbol.asyncIterator]().next();
			expect(value).toEqual({
				seq: expect.any(Number),
				event: streamEvent("session.ended", { sessionId: signedIn.id }),
			});
		} finally {
			stop.abort();
			await bus.close();
		}
	});

	it("replays session and member events only after the transaction commits", async () => {
		const member = await seedMember(workspaceId, "editor");
		const ending = await seedSession(member);
		const stillSignedIn = await seedSession(member);
		const stream = memberStream(member);
		const store = await runOnPostgres(EventStore.make);
		const bus = EventBus.inProcess();
		const ended = streamEvent("session.ended", { sessionId: ending.id });
		const told = streamEvent("approvals.changed", { toolCallId: crypto.randomUUID() });
		const change = Effect.flatMap(
			EventOutbox.make.pipe(Effect.provideService(EventBus.Service, bus)),
			(outbox) =>
				Effect.gen(function* () {
					yield* outbox.publish([{ stream, event: told }]);
					yield* query((db) => db.delete(session).where(eq(session.id, ending.id)));
				}),
		);
		const cursor = (await store.latest([stream])).get(stream) ?? 0;
		const replayed = async () => (await store.replay(stream, cursor, 3)).map(({ event }) => event);

		try {
			await expect(
				runOnPostgres(transaction(change.pipe(Effect.andThen(Effect.fail("rolled back"))))),
			).rejects.toBe("rolled back");
			expect(await replayed()).toEqual([]);

			await runOnPostgres(transaction(change));
			const committed = await replayed();
			expect(committed).toHaveLength(2);
			expect(committed).toEqual(expect.arrayContaining([ended, told]));
			expect(committed).not.toContainEqual(
				streamEvent("session.ended", { sessionId: stillSignedIn.id }),
			);
		} finally {
			await bus.close();
		}
	});
});
