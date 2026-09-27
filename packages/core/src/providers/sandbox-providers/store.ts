import type {
	NewSandboxProvider,
	SandboxProvider,
	SandboxProviderUpdate,
} from "@sugabots/contracts";
import { DEFAULT_SANDBOX_ALLOWED_HOSTS, sandboxProviderPreset } from "@sugabots/contracts";
import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { Credentials } from "../../credentials/credentials.ts";
import { type Database, query } from "../../database/database.ts";
import { type SandboxProviderRow, sandboxProvider } from "../../database/schema.ts";
import type { Sandbox } from "../../sandboxes/sandbox.ts";

/**
 * Reading and writing a workspace's one sandbox provider.
 *
 * `resolve` is what a turn asks: the connection, only while the provider is
 * enabled and has its key. `connection` is what a test asks: the same without
 * the enabled check, since a test is how an admin finds out whether to enable it.
 */
export interface SandboxProviderStore {
	get(workspaceId: string): Effect.Effect<SandboxProvider | undefined, never, Database>;
	/** Sets the workspace's provider, replacing whatever it had. */
	replace(
		workspaceId: string,
		userId: string,
		input: NewSandboxProvider,
	): Effect.Effect<SandboxProvider, never, Database>;
	update(
		workspaceId: string,
		input: SandboxProviderUpdate,
	): Effect.Effect<SandboxProvider | undefined, never, Database>;
	remove(workspaceId: string): Effect.Effect<boolean, never, Database>;
	connection(workspaceId: string): Effect.Effect<Sandbox.Connection | undefined, never, Database>;
	resolve(workspaceId: string): Effect.Effect<Sandbox.Connection | undefined, never, Database>;
	recordTest(
		workspaceId: string,
		configurationUpdatedAt: Date,
		error?: string,
	): Effect.Effect<void, never, Database>;
}

export function sandboxProviderStore(cipher: Credentials.Interface): SandboxProviderStore {
	const load = (workspaceId: string) =>
		query((db) =>
			db
				.select()
				.from(sandboxProvider)
				.where(eq(sandboxProvider.workspaceId, workspaceId))
				.limit(1)
				.pipe(Effect.map(([row]) => row)),
		);

	return {
		get: (workspaceId) => Effect.map(load(workspaceId), (row) => row && toSandboxProvider(row)),

		replace: (workspaceId, userId, input) =>
			Effect.gen(function* () {
				const preset = sandboxProviderPreset(input.preset);
				const values = {
					preset: input.preset,
					baseUrl: input.baseUrl ?? preset.baseUrl,
					apiKeyEncrypted: input.apiKey ? cipher.encrypt(input.apiKey) : null,
					image: input.image ?? preset.defaultImage,
					isolation: input.isolation ?? "gvisor",
					allowedHosts: input.allowedHosts ?? [...DEFAULT_SANDBOX_ALLOWED_HOSTS],
					enabled: input.enabled ?? false,
					lastTestedAt: null,
					lastTestError: null,
				};
				const [row] = yield* query((db) =>
					db
						.insert(sandboxProvider)
						.values({ workspaceId, createdById: userId, ...values })
						.onConflictDoUpdate({
							target: sandboxProvider.workspaceId,
							set: { ...values, createdById: userId },
						})
						.returning(),
				);
				if (!row) {
					return yield* Effect.die(new Error("Sandbox provider upsert returned no row"));
				}
				return toSandboxProvider(row);
			}),

		update: (workspaceId, input) =>
			Effect.gen(function* () {
				const connectionChanged = input.baseUrl !== undefined || input.apiKey !== undefined;
				const [row] = yield* query((db) =>
					db
						.update(sandboxProvider)
						.set({
							enabled: input.enabled,
							baseUrl: input.baseUrl,
							apiKeyEncrypted:
								input.apiKey === undefined
									? undefined
									: input.apiKey === null
										? null
										: cipher.encrypt(input.apiKey),
							image: input.image,
							isolation: input.isolation,
							allowedHosts: input.allowedHosts,
							lastTestedAt: connectionChanged ? null : undefined,
							lastTestError: connectionChanged ? null : undefined,
						})
						.where(eq(sandboxProvider.workspaceId, workspaceId))
						.returning(),
				);
				return row && toSandboxProvider(row);
			}),

		remove: (workspaceId) =>
			Effect.map(
				query((db) =>
					db
						.delete(sandboxProvider)
						.where(eq(sandboxProvider.workspaceId, workspaceId))
						.returning({ id: sandboxProvider.id }),
				),
				(rows) => rows.length > 0,
			),

		connection: (workspaceId) =>
			Effect.map(load(workspaceId), (row) => (row ? toConnection(row, cipher) : undefined)),

		resolve: (workspaceId) =>
			Effect.map(load(workspaceId), (row) =>
				row?.enabled ? toConnection(row, cipher) : undefined,
			),

		recordTest: (workspaceId, configurationUpdatedAt, error) =>
			Effect.asVoid(
				query((db) =>
					db
						.update(sandboxProvider)
						.set({ lastTestedAt: new Date(), lastTestError: error ?? null })
						.where(
							and(
								eq(sandboxProvider.workspaceId, workspaceId),
								// The row keeps microseconds when Postgres stamped it; the Date
								// we were handed back keeps milliseconds. Compare at the coarser one.
								sql`date_trunc('milliseconds', ${sandboxProvider.updatedAt}) = ${configurationUpdatedAt}`,
							),
						),
				),
			),
	};
}

/** The connection, or nothing when the row has no key to call the service with. */
function toConnection(
	row: SandboxProviderRow,
	cipher: Credentials.Interface,
): Sandbox.Connection | undefined {
	if (!row.apiKeyEncrypted) return undefined;
	return {
		preset: row.preset,
		baseUrl: row.baseUrl,
		apiKey: cipher.decrypt(row.apiKeyEncrypted),
		image: row.image,
		isolation: row.isolation,
		allowedHosts: row.allowedHosts.includes("*")
			? { kind: "any" }
			: { kind: "only", hosts: row.allowedHosts },
		configurationUpdatedAt: row.updatedAt,
	};
}

function toSandboxProvider(row: SandboxProviderRow): SandboxProvider {
	const hasApiKey = row.apiKeyEncrypted !== null;
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		preset: row.preset,
		name: sandboxProviderPreset(row.preset).name,
		baseUrl: row.baseUrl,
		image: row.image,
		isolation: row.isolation,
		allowedHosts: row.allowedHosts,
		enabled: row.enabled,
		status: !hasApiKey
			? "missing_key"
			: row.lastTestedAt === null
				? "untested"
				: row.lastTestError
					? "error"
					: "connected",
		hasApiKey,
		lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
		lastTestError: row.lastTestError,
		createdAt: row.createdAt.toISOString(),
	};
}
