import type {
	NewSandboxProvider,
	SandboxIsolation,
	SandboxProviderTestResult,
	SandboxProviderUpdate,
} from "@sugabots/contracts";
import { sandboxProviderPreset } from "@sugabots/contracts";
import { Data, Effect } from "effect";
import type { Database } from "../../database/database.ts";
import { Sandbox } from "../../sandboxes/sandbox.ts";
import type { PodSandboxStore } from "../../sandboxes/store.ts";
import type { EgressUrlValidator } from "../network/egress.ts";
import type { SandboxProviderStore } from "./store.ts";

export class SandboxProviderNotFound extends Data.TaggedError("SandboxProviderNotFound") {
	override get message() {
		return "This workspace has no sandbox provider";
	}
}

export class SandboxProviderUrlNotAllowed extends Data.TaggedError("SandboxProviderUrlNotAllowed") {
	override get message() {
		return "Sandbox provider URL is not allowed by the network policy";
	}
}

export class SandboxProviderApiKeyRequired extends Data.TaggedError(
	"SandboxProviderApiKeyRequired",
) {
	override get message() {
		return "Add an API key before enabling sandboxes";
	}
}

export class SandboxIsolationNotAllowed extends Data.TaggedError("SandboxIsolationNotAllowed") {
	override get message() {
		return "This installation does not allow sandboxes that share the host's kernel. Its operator can allow them with SANDBOX_ALLOW_UNISOLATED.";
	}
}

export interface SandboxProviderOperationsOptions {
	providers: SandboxProviderStore;
	/** The model providers' address policy: a sandbox service is usually on this machine's network. */
	validateProviderUrl: EgressUrlValidator;
	/** Whether this installation lets a workspace choose `container` isolation. */
	allowsUnisolated: boolean;
	/** So a change to the allowed hosts reaches sandboxes already running. */
	podSandboxes?: Pick<PodSandboxStore, "applyAllowedHosts">;
}

export function sandboxProviderOperations({
	providers,
	validateProviderUrl,
	allowsUnisolated,
	podSandboxes,
}: SandboxProviderOperationsOptions) {
	const requireProvider = (workspaceId: string) =>
		Effect.filterOrFail(
			providers.get(workspaceId),
			(provider) => provider != null,
			() => new SandboxProviderNotFound(),
		);

	const requireAllowedUrl = (baseUrl: string) =>
		Effect.tryPromise({
			try: () => validateProviderUrl(baseUrl),
			catch: () => new SandboxProviderUrlNotAllowed(),
		});

	const requireAllowedIsolation = (isolation: SandboxIsolation | undefined) =>
		isolation === "container" && !allowsUnisolated
			? Effect.fail(new SandboxIsolationNotAllowed())
			: Effect.void;

	return {
		get: (workspaceId: string) =>
			Effect.map(providers.get(workspaceId), (provider) => ({
				provider: provider ?? null,
				allowsUnisolated,
			})),

		replace: (workspaceId: string, userId: string, input: NewSandboxProvider) =>
			Effect.gen(function* () {
				yield* requireAllowedUrl(input.baseUrl ?? sandboxProviderPreset(input.preset).baseUrl);
				yield* requireAllowedIsolation(input.isolation);
				if (input.enabled && !input.apiKey) {
					return yield* new SandboxProviderApiKeyRequired();
				}
				return yield* providers.replace(workspaceId, userId, input);
			}),

		update: (workspaceId: string, input: SandboxProviderUpdate) =>
			Effect.gen(function* () {
				const current = yield* requireProvider(workspaceId);
				if (input.baseUrl) {
					yield* requireAllowedUrl(input.baseUrl);
				}
				yield* requireAllowedIsolation(input.isolation);
				const keyAfter = input.apiKey === undefined ? current.hasApiKey : input.apiKey !== null;
				if ((input.enabled ?? current.enabled) && !keyAfter) {
					return yield* new SandboxProviderApiKeyRequired();
				}
				const updated = yield* providers.update(workspaceId, input);
				if (input.allowedHosts && podSandboxes) {
					yield* podSandboxes.applyAllowedHosts(workspaceId);
				}
				return updated ?? (yield* requireProvider(workspaceId));
			}),

		remove: (workspaceId: string) =>
			Effect.filterOrFail(
				providers.remove(workspaceId),
				(removed) => removed,
				() => new SandboxProviderNotFound(),
			).pipe(Effect.asVoid),

		test: (
			workspaceId: string,
		): Effect.Effect<SandboxProviderTestResult, SandboxProviderNotFound, Database> =>
			Effect.gen(function* () {
				yield* requireProvider(workspaceId);
				const connection = yield* providers.connection(workspaceId);
				if (!connection) {
					return { reachable: false, latencyMs: 0, error: "Add an API key before testing" };
				}
				const started = Date.now();
				const error = yield* Sandbox.forConnection(connection).check.pipe(
					Effect.as(undefined),
					Effect.catch((failure) => Effect.succeed(describeUnavailable(failure))),
				);
				yield* providers.recordTest(workspaceId, connection.configurationUpdatedAt, error);
				return {
					reachable: error === undefined,
					latencyMs: Date.now() - started,
					...(error === undefined ? {} : { error }),
				};
			}),
	};
}

function describeUnavailable(failure: Sandbox.Unavailable): string {
	const cause = failure.cause;
	if (cause && typeof cause === "object" && "statusCode" in cause) {
		if (cause.statusCode === 401 || cause.statusCode === 403) {
			return "The sandbox service refused the API key.";
		}
		return `The sandbox service answered ${String(cause.statusCode)}.`;
	}
	return cause instanceof Error
		? `Could not reach the sandbox service: ${cause.message}`
		: "Could not reach the sandbox service.";
}
