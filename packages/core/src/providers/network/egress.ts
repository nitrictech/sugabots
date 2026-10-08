export * as Egress from "./egress.ts";

import { lookup as nodeLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { type UserText, userText } from "@sugabots/errors";
import { Config, Context, Data, Effect, Layer, Option } from "effect";
import {
	Agent,
	type Dispatcher,
	type RequestInit as UndiciRequestInit,
	fetch as undiciFetch,
} from "undici";
import { Installation } from "../../installation/installation.ts";
import type { UserFacing } from "../../user-message.ts";

/** The clients the API reaches the outside world with, each under this installation's egress policy. */
export interface Interface {
	/** For model providers and model discovery: a client bound to one provider's base URL. */
	readonly providers: EgressHttpClients;
	/** Checks an address a workspace gives for a provider or connection, under the providers' policy. */
	readonly validateProviderUrl: (url: string) => Effect.Effect<void, EgressRefused>;
	/**
	 * Unbound, under the providers' policy. A connection's sign-in goes wherever
	 * its authorization server says: its well-known documents, then often
	 * another host.
	 */
	readonly oauth: EgressHttpClient;
	/** Unbound, under its own policy, for the `web_fetch` tool: a page may be anywhere. */
	readonly webFetch: EgressHttpClient;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Egress") {}

/**
 * Reads the two policies: the addresses a workspace gives, for its model and
 * search providers and its connections, may be plain HTTP or on a local network
 * outside production unless `ALLOW_UNSAFE_WORKSPACE_URLS` says otherwise, and
 * `web_fetch` may not unless `ALLOW_PRIVATE_WEB_FETCH_NETWORK` says it may.
 * The clients close when the layer does.
 */
export const make = Effect.gen(function* () {
	const installation = yield* Installation.Service;
	const allowUnsafeWorkspaceUrls = yield* unsafeWorkspaceUrls(!installation.isProduction);
	const allowPrivateWebFetchNetwork = yield* Config.Boolean("ALLOW_PRIVATE_WEB_FETCH_NETWORK").pipe(
		Config.withDefault(false),
	);
	return {
		providers: yield* closedWithLayer(() =>
			createEgressHttpClients({ allowPrivateNetwork: allowUnsafeWorkspaceUrls }),
		),
		validateProviderUrl: urlValidation(
			createEgressUrlValidator({ allowPrivateNetwork: allowUnsafeWorkspaceUrls }),
		),
		oauth: yield* closedWithLayer(() =>
			createEgressHttpClient({ allowPrivateNetwork: allowUnsafeWorkspaceUrls }),
		),
		webFetch: yield* closedWithLayer(() =>
			createEgressHttpClient({ allowPrivateNetwork: allowPrivateWebFetchNetwork }),
		),
	} satisfies Interface;
});

export const layer = Layer.effect(Service, make);

/**
 * How the API reaches the outside world: `fetch`, with this installation's
 * egress policy already applied. Every destination is resolved first and its
 * addresses checked against the private and reserved ranges, the connection is
 * pinned to the addresses that passed, and redirects are never followed on the
 * caller's behalf, since each hop needs the same check.
 *
 * Two callers. The model SDKs and model discovery take a client bound to one
 * provider's base URL (`EgressHttpClients`); the `web_fetch` tool takes an
 * unbound one (`createEgressHttpClient`) because a page may be anywhere.
 */
export type EgressHttpClient = typeof fetch;
export type ClosableEgressHttpClient = EgressHttpClient & { close(): Promise<void> };

/** The service being called; a bound client goes nowhere but under its base URL. */
interface EgressEndpoint {
	baseUrl: string;
}

/** Hands out the client for one endpoint. */
export interface EgressHttpClients {
	for(endpoint: EgressEndpoint): EgressHttpClient;
}

/** The clients the process owns; closing them closes every held connection. */
export interface ClosableEgressHttpClients extends EgressHttpClients {
	close(): Promise<void>;
}

type EgressUrlValidator = (value: string) => Promise<void>;

interface ResolvedAddress {
	address: string;
	family: 4 | 6;
}

export type EgressDispatch = (
	input: Parameters<EgressHttpClient>[0],
	init: Omit<RequestInit, "dispatcher"> & { dispatcher: Dispatcher },
) => Promise<Response>;

export interface EgressOptions {
	allowPrivateNetwork?: boolean;
	lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
	fetch?: EgressDispatch;
	dispatcherFactory?: (hostname: string, addresses?: ResolvedAddress[]) => Dispatcher;
	maxDispatchers?: number;
}

const MAX_DISPATCHERS = 100;

const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();

for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	blockedIpv4Addresses.addSubnet(address, prefix, "ipv4");
}

for (const [address, prefix] of [
	["::", 128],
	["::1", 128],
	["::ffff:0:0", 96],
	["64:ff9b::", 96],
	["64:ff9b:1::", 48],
	["100::", 64],
	["2001::", 23],
	["2001:2::", 48],
	["2001:10::", 28],
	["2001:db8::", 32],
	["2002::", 16],
	["3fff::", 20],
	["5f00::", 16],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const) {
	blockedIpv6Addresses.addSubnet(address, prefix, "ipv6");
}

/** One client, pooling a pinned dispatcher per destination, under one policy. */
export function createEgressHttpClient({
	allowPrivateNetwork = false,
	lookup = resolveHostname,
	fetch: dispatch = dispatchWithUndici,
	dispatcherFactory = pinnedDispatcher,
	maxDispatchers = MAX_DISPATCHERS,
}: EgressOptions = {}): ClosableEgressHttpClient {
	if (!Number.isInteger(maxDispatchers) || maxDispatchers < 1) {
		throw new TypeError("maxDispatchers must be a positive integer");
	}
	const dispatchers = new Map<string, Dispatcher>();

	const client = async (input: Parameters<EgressHttpClient>[0], init?: RequestInit) => {
		const { hostname, addresses } = await resolveEgressUrl(
			input instanceof Request ? input.url : input.toString(),
			allowPrivateNetwork,
			lookup,
		);
		const key = `${hostname}\n${addresses?.map(({ address, family }) => `${family}:${address}`).join(",") ?? "private"}`;
		let dispatcher = dispatchers.get(key);
		if (dispatcher) {
			dispatchers.delete(key);
			dispatchers.set(key, dispatcher);
		} else {
			dispatcher = dispatcherFactory(hostname, addresses);
			dispatchers.set(key, dispatcher);
			if (dispatchers.size > maxDispatchers) {
				const oldest = dispatchers.entries().next().value;
				if (oldest) {
					dispatchers.delete(oldest[0]);
					await oldest[1].close();
				}
			}
		}
		const dispatchInit = {
			...init,
			redirect: "manual" as const,
			dispatcher,
		} as unknown as Parameters<EgressDispatch>[1];
		return asRuntimeResponse(await dispatch(input, dispatchInit));
	};

	return Object.assign(client as EgressHttpClient, {
		async close() {
			const closing = [...dispatchers.values()].map((dispatcher) => dispatcher.close());
			dispatchers.clear();
			await Promise.all(closing);
		},
	});
}

/**
 * One connection pool under the installation's network policy, handed out
 * bound to the provider it was asked for. The policy is the installation's
 * because it is a question about who runs it: a self-hosted install on a
 * trusted network may reach anything on it, a hosted one serving many tenants
 * may not let one tenant's provider reach another's, or the host's own
 * services. What software answers at the address — Ollama, vLLM, a gateway —
 * says nothing about that, so no preset is exempt.
 *
 * The binding is what makes the policy hold: the client goes to an SDK that
 * builds its own request paths, so a client refuses to leave the base URL of
 * the provider it was issued for.
 */
export function createEgressHttpClients(options: EgressOptions = {}): ClosableEgressHttpClients {
	const pool = createEgressHttpClient(options);

	return {
		for(endpoint) {
			return async (input, init) => {
				requireUrlUnderBase(
					input instanceof Request ? input.url : input.toString(),
					endpoint.baseUrl,
				);
				return pool(input, init);
			};
		},
		close: () => pool.close(),
	};
}

/**
 * The network policy refused a request before it was sent. Its `userMessage`
 * is also fit for a model whose tool asked for the address.
 */
export class EgressRefused
	extends Data.TaggedError("EgressRefused")<{ readonly reason: EgressRefusal }>
	implements UserFacing
{
	override get message() {
		return `Egress refused: ${this.userMessage}`;
	}
	get userMessage() {
		return EGRESS_REFUSAL_USER_MESSAGES[this.reason];
	}
}

type EgressRefusal =
	| "outsideBaseUrl"
	| "unresolved"
	| "invalidAddress"
	| "privateNetwork"
	| "invalidUrl"
	| "notHttp"
	| "credentials"
	| "fragment"
	| "notHttps";

const EGRESS_REFUSAL_USER_MESSAGES: Record<EgressRefusal, UserText> = {
	outsideBaseUrl: userText`That address isn't under the provider's address, so Sugabots won't send the provider's key there. Use an address that starts with the provider's address.`,
	unresolved: userText`Sugabots couldn't find a server with that name. Check the address is spelled correctly, and that the name can be looked up from wherever Sugabots runs.`,
	invalidAddress: userText`That server's name points to an address Sugabots can't connect to. Check the address, or the server's DNS records.`,
	privateNetwork: userText`That address is on a local or private network, which this installation doesn't connect to, so other services on the network stay out of reach. Use a public address, or ask whoever runs Sugabots to allow local network addresses.`,
	invalidUrl: userText`That isn't a complete web address. Check it starts with https:// and has no spaces.`,
	notHttp: userText`Sugabots only connects to web addresses. Use one that starts with https://.`,
	credentials: userText`That address has a username or password in it, which Sugabots won't send in an address. Remove them, and give the credential as an access token instead.`,
	fragment: userText`That address has a # part, which is never sent to the server. Remove the # and everything after it.`,
	notHttps: userText`That address uses plain HTTP, which this installation doesn't connect to, so keys and messages aren't sent unencrypted. Use the server's https:// address, or ask whoever runs Sugabots to allow plain HTTP.`,
};

function requireUrlUnderBase(value: string, baseUrl: string) {
	const base = egressUrl(baseUrl, { allowHttp: true });
	const requested = egressUrl(value, { allowHttp: true });
	const path = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
	if (
		requested.origin !== base.origin ||
		(requested.pathname !== base.pathname && !requested.pathname.startsWith(path))
	) {
		throw new EgressRefused({ reason: "outsideBaseUrl" });
	}
}

/**
 * `validate` as an Effect. A lookup that throws rather than answering is a
 * hostname that did not resolve, so every failure is a refusal.
 */
export function urlValidation(
	validate: EgressUrlValidator,
): (url: string) => Effect.Effect<void, EgressRefused> {
	return (url) =>
		Effect.tryPromise({
			try: () => validate(url),
			catch: (cause) =>
				cause instanceof EgressRefused ? cause : new EgressRefused({ reason: "unresolved" }),
		});
}

export function createEgressUrlValidator({
	allowPrivateNetwork = false,
	lookup = resolveHostname,
}: Pick<EgressOptions, "allowPrivateNetwork" | "lookup"> = {}): EgressUrlValidator {
	return async (value) => {
		await resolveEgressUrl(value, allowPrivateNetwork, lookup);
	};
}

async function resolveEgressUrl(
	value: string,
	allowPrivateNetwork: boolean,
	lookup: NonNullable<EgressOptions["lookup"]>,
) {
	const url = egressUrl(value, { allowHttp: allowPrivateNetwork });
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const addresses = allowPrivateNetwork ? undefined : await safeAddresses(hostname, lookup);
	return { hostname, addresses };
}

async function safeAddresses(
	hostname: string,
	lookup: NonNullable<EgressOptions["lookup"]>,
): Promise<ResolvedAddress[]> {
	const addressFamily = isIP(hostname);
	const addresses = addressFamily
		? [{ address: hostname, family: addressFamily }]
		: await lookup(hostname);
	if (addresses.length === 0) throw new EgressRefused({ reason: "unresolved" });
	return addresses.map(({ address, family }) => {
		if (isIP(address) !== family || (family !== 4 && family !== 6)) {
			throw new EgressRefused({ reason: "invalidAddress" });
		}
		const blocked =
			family === 4
				? blockedIpv4Addresses.check(address, "ipv4")
				: blockedIpv6Addresses.check(address, "ipv6");
		if (blocked) throw new EgressRefused({ reason: "privateNetwork" });
		return { address, family };
	});
}

function pinnedDispatcher(hostname: string, addresses?: ResolvedAddress[]): Dispatcher {
	let nextAddress = 0;
	return new Agent({
		connect: addresses
			? {
					servername: isIP(hostname) ? undefined : hostname,
					lookup: (_requestedHostname, options, callback) => {
						if (options.all) {
							callback(null, addresses);
							return;
						}
						const selected = addresses[nextAddress++ % addresses.length];
						if (!selected) {
							callback(new Error("Hostname did not resolve"), "", 0);
							return;
						}
						callback(null, selected.address, selected.family);
					},
				}
			: undefined,
	});
}

/**
 * undici's `Response` is its own class, not the runtime's, so a caller that
 * asks `instanceof Response` (the AI SDK's OAuth client does, before reading
 * an error body) would decide it had been handed something else and read
 * nothing. The answer is re-homed onto the runtime's class, keeping the final
 * URL, which the page fetcher reads after a redirect.
 */
function asRuntimeResponse(
	answered: Pick<Response, "body" | "status" | "statusText" | "headers" | "url">,
): Response {
	if (answered instanceof Response) return answered;
	if (answered.status < 200 || answered.status > 599) return answered as Response;
	const response = new Response(answered.body, {
		status: answered.status,
		statusText: answered.statusText,
		headers: [...answered.headers.entries()],
	});
	Object.defineProperty(response, "url", { value: answered.url });
	return response;
}

async function dispatchWithUndici(
	input: Parameters<EgressHttpClient>[0],
	init: Omit<RequestInit, "dispatcher"> & { dispatcher: Dispatcher },
): Promise<Response> {
	return undiciFetch(
		input as unknown as Parameters<typeof undiciFetch>[0],
		init as unknown as UndiciRequestInit,
	) as unknown as Response;
}

function egressUrl(value: string, { allowHttp = false }: { allowHttp?: boolean } = {}): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new EgressRefused({ reason: "invalidUrl" });
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new EgressRefused({ reason: "notHttp" });
	}
	if (url.username || url.password) throw new EgressRefused({ reason: "credentials" });
	if (url.hash) throw new EgressRefused({ reason: "fragment" });
	if (url.protocol === "http:" && !allowHttp) throw new EgressRefused({ reason: "notHttps" });
	return url;
}

async function resolveHostname(hostname: string) {
	return nodeLookup(hostname, { all: true, verbatim: true });
}

function closedWithLayer<A extends { close(): Promise<void> }>(create: () => A) {
	return Effect.acquireRelease(Effect.sync(create), (acquired) =>
		Effect.promise(() => acquired.close()),
	);
}

const UNSAFE_WORKSPACE_URLS = "ALLOW_UNSAFE_WORKSPACE_URLS";
/** The deprecated name for `UNSAFE_WORKSPACE_URLS`, still read so existing installations keep working. */
const DEPRECATED_UNSAFE_WORKSPACE_URLS = "ALLOW_PRIVATE_MODEL_PROVIDER_NETWORK";

/**
 * unsafeWorkspaceUrls reads whether workspaces may give plain-HTTP and
 * local-network addresses: `UNSAFE_WORKSPACE_URLS` if set, else
 * `DEPRECATED_UNSAFE_WORKSPACE_URLS`, else `defaultValue`. It logs a warning
 * whenever `DEPRECATED_UNSAFE_WORKSPACE_URLS` is set.
 */
function unsafeWorkspaceUrls(defaultValue: boolean) {
	return Effect.gen(function* () {
		const current = yield* Config.option(Config.Boolean(UNSAFE_WORKSPACE_URLS));
		const deprecated = yield* Config.option(Config.Boolean(DEPRECATED_UNSAFE_WORKSPACE_URLS));
		if (Option.isSome(deprecated)) {
			yield* Effect.logWarning(
				`${DEPRECATED_UNSAFE_WORKSPACE_URLS} is deprecated: set ${UNSAFE_WORKSPACE_URLS} instead`,
			);
		}
		return Option.getOrElse(
			Option.orElse(current, () => deprecated),
			() => defaultValue,
		);
	});
}
