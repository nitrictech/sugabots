export * as Devices from "./devices.ts";

import { createHash, randomInt } from "node:crypto";
import type {
	Device,
	DevicePairingRequest,
	LocalAgent,
	LocalAgentKind,
	PendingDevicePairing,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, desc, eq } from "drizzle-orm";
import { Context, Data, DateTime, Duration, Effect, Layer } from "effect";
import { CurrentActor } from "../authorization/current-actor.ts";
import { Database, query } from "../database/database.ts";
import { type DeviceRow, device } from "../database/schema.ts";
import type { UserFacing } from "../user-message.ts";
import { DeviceLinks } from "./device-links.ts";

/** People's computers running the desktop app: pairing them, and what they lend while connected. */
export interface Interface {
	/**
	 * Starts pairing a desktop holding the token whose SHA-256 is `tokenDigest`,
	 * and returns the code somebody signed in approves it with.
	 */
	readonly requestPairing: (request: DevicePairingRequest) => Effect.Effect<{ code: string }>;
	/** The pairing waiting under `code`, for the person about to approve it. */
	readonly pendingPairing: (
		code: string,
	) => Effect.Effect<PendingDevicePairing, DevicePairingNotFound, CurrentActor.Service>;
	/** Pairs the desktop waiting under `code` to the actor. */
	readonly approvePairing: (
		code: string,
	) => Effect.Effect<Device, DevicePairingNotFound, CurrentActor.Service>;
	/** The actor's devices, newest first. */
	readonly list: Effect.Effect<ReadonlyArray<Device>, never, CurrentActor.Service>;
	/** The actor's device `deviceId`. */
	readonly owned: (deviceId: string) => Effect.Effect<Device, DeviceNotFound, CurrentActor.Service>;
	/**
	 * Asks the owner, on the actor's device `deviceId`, to lend an agent of
	 * `kind` in a folder they choose there, and waits for their answer.
	 */
	readonly lend: (
		deviceId: string,
		kind: LocalAgentKind,
	) => Effect.Effect<
		LocalAgent,
		DeviceNotFound | DeviceLinks.DeviceOffline | DeviceLinks.LendingDeclined,
		CurrentActor.Service
	>;
	/** Has the actor's device `deviceId` stop lending the agent at `url`. */
	readonly stopLending: (
		deviceId: string,
		url: string,
	) => Effect.Effect<void, DeviceNotFound | DeviceLinks.DeviceOffline, CurrentActor.Service>;
	/** Unpairs one of the actor's devices, closing its link. Bots standing for its agents stop reaching them. */
	readonly forget: (deviceId: string) => Effect.Effect<void, DeviceNotFound, CurrentActor.Service>;
	/** The paired device holding `token`, or nothing. */
	readonly authenticate: (token: string) => Effect.Effect<DeviceRow | undefined>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Devices") {}

export const make = Effect.gen(function* () {
	const database = yield* Database;
	const links = yield* DeviceLinks.Service;
	/** Pairings waiting for approval, by code. Lost on restart, when the desktop asks again. */
	const pending = new Map<string, PendingPairing>();

	const toDevice = (row: DeviceRow): Device => ({
		id: row.id,
		name: row.name,
		agents: links.agents(row.id) ?? null,
		createdAt: row.createdAt.toISOString(),
	});

	const waiting = (code: string) =>
		Effect.gen(function* () {
			const now = yield* DateTime.now;
			const pairing = pending.get(normalizedCode(code));
			if (!pairing || DateTime.isGreaterThan(now, pairing.expiresAt)) {
				return yield* new DevicePairingNotFound();
			}
			return pairing;
		});

	const owned = (deviceId: string) =>
		Effect.gen(function* () {
			const { userId } = yield* CurrentActor.Service;
			const [row] = yield* query((db) =>
				db
					.select()
					.from(device)
					.where(and(eq(device.id, deviceId), eq(device.ownerId, userId))),
			);
			if (!row) return yield* new DeviceNotFound();
			return row;
		}).pipe(Effect.provideService(Database, database));

	return Service.of({
		requestPairing: ({ name, tokenDigest }) =>
			Effect.gen(function* () {
				const now = yield* DateTime.now;
				for (const [code, pairing] of pending) {
					if (DateTime.isGreaterThan(now, pairing.expiresAt)) pending.delete(code);
				}
				const code = newPairingCode();
				pending.set(code, {
					name,
					tokenDigest,
					expiresAt: DateTime.addDuration(now, PAIRING_LIFETIME),
				});
				return { code: formattedCode(code) };
			}),

		pendingPairing: (code) =>
			Effect.map(waiting(code), ({ name }) => ({
				code: formattedCode(normalizedCode(code)),
				name,
			})),

		approvePairing: (code) =>
			Effect.gen(function* () {
				const pairing = yield* waiting(code);
				pending.delete(normalizedCode(code));
				const { userId } = yield* CurrentActor.Service;
				const [row] = yield* query((db) =>
					db
						.insert(device)
						.values({ ownerId: userId, name: pairing.name, tokenDigest: pairing.tokenDigest })
						.returning(),
				);
				if (!row) return yield* Effect.die("Inserting a device returned no row");
				return toDevice(row);
			}).pipe(Effect.provideService(Database, database)),

		list: Effect.gen(function* () {
			const { userId } = yield* CurrentActor.Service;
			const rows = yield* query((db) =>
				db.select().from(device).where(eq(device.ownerId, userId)).orderBy(desc(device.createdAt)),
			);
			return rows.map(toDevice);
		}).pipe(Effect.provideService(Database, database)),

		owned: (deviceId) => Effect.map(owned(deviceId), toDevice),

		lend: (deviceId, kind) => Effect.flatMap(owned(deviceId), (row) => links.lend(row.id, kind)),

		stopLending: (deviceId, url) =>
			Effect.flatMap(owned(deviceId), (row) => links.stopLending(row.id, url)),

		forget: (deviceId) =>
			Effect.gen(function* () {
				const row = yield* owned(deviceId);
				yield* query((db) => db.delete(device).where(eq(device.id, row.id)));
				yield* links.disconnect(row.id);
			}).pipe(Effect.provideService(Database, database)),

		authenticate: (token) =>
			query((db) =>
				db
					.select()
					.from(device)
					.where(eq(device.tokenDigest, tokenDigestOf(token))),
			).pipe(
				Effect.map(([row]) => row),
				Effect.provideService(Database, database),
			),
	});
});

export const layer = Layer.effect(Service, make);

/** How long a desktop's pairing code waits for somebody to approve it. */
const PAIRING_LIFETIME = Duration.minutes(10);

interface PendingPairing {
	name: string;
	tokenDigest: string;
	expiresAt: DateTime.Utc;
}

/** The token's SHA-256, hex: what a desktop sends when it asks to be paired, and all that is kept. */
export function tokenDigestOf(token: string) {
	return createHash("sha256").update(token).digest("hex");
}

/** Letters and digits that can't be mistaken for one another when read off a screen. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

function newPairingCode() {
	return Array.from(
		{ length: CODE_LENGTH },
		() => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
	).join("");
}

/** The code as people read it: two groups of four. */
function formattedCode(code: string) {
	return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** The code however it was typed or linked: any case, with or without its dash. */
function normalizedCode(code: string) {
	return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export class DevicePairingNotFound
	extends Data.TaggedError("DevicePairingNotFound")
	implements UserFacing
{
	get userMessage() {
		return userText`That pairing code has expired or was never issued. Pair the desktop app again to get a new one.`;
	}
}

export class DeviceNotFound extends Data.TaggedError("DeviceNotFound") implements UserFacing {
	get userMessage() {
		return userText`That device isn't one of yours, or it has been unpaired.`;
	}
}
