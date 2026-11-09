import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { type ClientHttp2Session, connect, constants } from "node:http2";
import type { ApnsEnvironment, NotificationContent } from "@sugabots/contracts";
import { Clock, Effect, Redacted } from "effect";
import { Push } from "../push.ts";

/** Apple's push service for each kind of build. */
export const APNS_ORIGINS: Record<ApnsEnvironment, string> = {
	production: "https://api.push.apple.com",
	development: "https://api.sandbox.push.apple.com",
};

export interface ApnsConfig {
	keyId: string;
	teamId: string;
	/** The `.p8` key, as PEM. */
	privateKey: Redacted.Redacted;
	/** The app's bundle identifier. */
	topic: string;
	/** Where each environment's service is: Apple's, unless a test stands in for it. */
	origins?: Record<ApnsEnvironment, string>;
	/** How long a request may go without a word from Apple: `DEFAULT_TIMEOUT_MS`, unless a test waits less. */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * How long one provider token is used. Apple refuses one older than an hour,
 * and one renewed more often than every 20 minutes.
 */
const PROVIDER_TOKEN_LIFETIME_MS = 50 * 60_000;

/** The largest payload Apple takes for an alert. */
const MAX_PAYLOAD_BYTES = 4096;

/** The most of a title a push carries; the body gets whatever room is left. */
const TITLE_CHARACTERS = 200;

/** What Apple answers for a token whose app was removed from the phone. */
const GONE_REASON = "Unregistered";

/**
 * What Apple answers for a token that is malformed, for another app, or for
 * its other environment: for a token a phone really gave, a wrong
 * `APNS_TOPIC` or a build that registered for the wrong environment. A topic
 * the key may not push to at all, `TopicDisallowed`, is this installation's
 * fault whatever the token, so it is a failed delivery instead.
 */
const REFUSED_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic"]);

/** What Apple answers when it no longer takes the provider token. */
const STALE_PROVIDER_TOKEN_REASONS = new Set(["ExpiredProviderToken", "InvalidProviderToken"]);

/**
 * Sends through Apple's push service over HTTP/2, which it requires, signed
 * with the app's push key. Keeps one connection to each environment while
 * pushes flow, drops one that stops answering, and closes them when the
 * layer does.
 */
export const fromApns = (config: ApnsConfig) =>
	Effect.gen(function* () {
		const key = yield* Effect.try({
			try: () => createPrivateKey(Redacted.value(config.privateKey).replaceAll("\\n", "\n")),
			catch: () =>
				new Push.InvalidConfig({ message: "APNS_PRIVATE_KEY must be the .p8 key's contents." }),
		});
		const providerTokens = providerTokenCache(key, config);
		const connections = connectionPool(config.origins ?? APNS_ORIGINS);
		const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		yield* Effect.addFinalizer(() => Effect.sync(connections.closeAll));

		const deliver = (device: Push.DeviceOf<"apns">, push: ApnsPush) =>
			Effect.gen(function* () {
				const providerToken = providerTokens.current(yield* Clock.currentTimeMillis);
				return yield* Effect.tryPromise({
					try: (signal) =>
						post(
							connections.to(device.environment),
							{
								[constants.HTTP2_HEADER_METHOD]: "POST",
								[constants.HTTP2_HEADER_PATH]: `/3/device/${device.token}`,
								authorization: `bearer ${providerToken}`,
								"apns-topic": config.topic,
								"apns-push-type": push.type,
								"apns-priority": push.priority,
								"content-type": "application/json",
							},
							JSON.stringify(push.payload),
							{ signal, timeoutMs },
						),
					catch: (cause) => new Push.DeliveryFailed({ service: "apns", cause }),
				});
			}).pipe(Effect.flatMap((response) => outcomeOf(response, providerTokens)));

		return {
			send: (device, notification) =>
				deliver(device, { type: "alert", priority: "10", payload: alertPayload(notification) }),
			// A background push with nothing in it: iOS hands it to no one, and Apple still says whether it takes the token.
			check: (device) =>
				deliver(device, {
					type: "background",
					priority: "5",
					payload: { aps: { "content-available": 1 } },
				}),
		} satisfies Push.Sender<"apns">;
	});

/** One request's kind, as Apple names it, its priority, and its JSON. */
interface ApnsPush {
	type: "alert" | "background";
	/** 10 for now, 5 for when the phone is next awake anyway, as Apple requires for a background push. */
	priority: "10" | "5";
	payload: object;
}

/**
 * The alert Apple shows, grouped with others about the same conversation,
 * with where it leads in the web app for the app to open when tapped, its
 * body as long as fits in Apple's bytes.
 */
function alertPayload(notification: NotificationContent) {
	const title = shortened(notification.title, TITLE_CHARACTERS);
	const payloadWith = (body: string) => ({
		aps: { alert: { title, body }, sound: "default", "thread-id": notification.tag },
		path: notification.path,
		conversationId: notification.conversationId,
	});
	const fits = (body: string) =>
		Buffer.byteLength(JSON.stringify(payloadWith(body))) <= MAX_PAYLOAD_BYTES;
	if (fits(notification.body)) return payloadWith(notification.body);
	// The most characters that fit: a character's bytes, escaped, run from one to twelve.
	let [fitting, tooMany] = [0, [...notification.body].length];
	while (tooMany - fitting > 1) {
		const middle = Math.floor((fitting + tooMany) / 2);
		if (fits(shortened(notification.body, middle))) fitting = middle;
		else tooMany = middle;
	}
	return payloadWith(shortened(notification.body, fitting));
}

/** `text` cut to `limit` characters, ending in an ellipsis where it was cut, or empty for a limit of none. */
function shortened(text: string, limit: number): string {
	const characters = [...text];
	if (characters.length <= limit) return text;
	return limit <= 1 ? "" : `${characters.slice(0, limit - 1).join("")}…`;
}

/** Succeeds for a push Apple took, and fails with why for one it refused. */
function outcomeOf(
	{ status, body }: { status: number; body: string },
	providerTokens: { renew: () => void },
): Effect.Effect<void, Push.Failure> {
	if (status === 200) return Effect.void;
	const reason = reasonOf(body);
	if (status === 410 || reason === GONE_REASON) {
		return Effect.fail(new Push.DeviceGone({ reason }));
	}
	if (REFUSED_REASONS.has(reason)) return Effect.fail(new Push.TokenRefused({ reason }));
	if (STALE_PROVIDER_TOKEN_REASONS.has(reason)) providerTokens.renew();
	return Effect.fail(new Push.DeliveryFailed({ service: "apns", cause: `${status} ${reason}` }));
}

function reasonOf(body: string): string {
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed === "object" && parsed !== null && "reason" in parsed) {
			return String(parsed.reason);
		}
	} catch {
		// Not JSON: the status is all there is to go on.
	}
	return "Unknown";
}

/** The JSON Web Token Apple takes in place of a certificate, signed with the push key, reused for its lifetime. */
function providerTokenCache(key: KeyObject, { keyId, teamId }: ApnsConfig) {
	let cached: { token: string; issuedAt: number } | undefined;
	return {
		/** The token to send at `now`, in milliseconds since the epoch. */
		current(now: number): string {
			if (!cached || now - cached.issuedAt >= PROVIDER_TOKEN_LIFETIME_MS) {
				cached = { token: signProviderToken(key, keyId, teamId, now), issuedAt: now };
			}
			return cached.token;
		},
		renew() {
			cached = undefined;
		},
	};
}

function signProviderToken(key: KeyObject, keyId: string, teamId: string, now: number): string {
	const header = base64Url({ alg: "ES256", kid: keyId });
	const claims = base64Url({ iss: teamId, iat: Math.floor(now / 1000) });
	const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
		key,
		dsaEncoding: "ieee-p1363",
	});
	return `${header}.${claims}.${signature.toString("base64url")}`;
}

function base64Url(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * One HTTP/2 connection to each environment's service, opened when first
 * needed and again after Apple, the network or a stalled request closes it.
 * An idle connection does not keep the process running.
 */
function connectionPool(origins: Record<ApnsEnvironment, string>) {
	const open = new Map<ApnsEnvironment, ClientHttp2Session>();
	const forget = (environment: ApnsEnvironment, session: ClientHttp2Session) => {
		if (open.get(environment) === session) open.delete(environment);
	};
	return {
		to(environment: ApnsEnvironment): ClientHttp2Session {
			const existing = open.get(environment);
			if (existing && !existing.closed && !existing.destroyed) return existing;
			const session = connect(origins[environment]);
			session.unref();
			// A failed connection fails the requests on it; the next push connects again.
			session.on("error", () => forget(environment, session));
			session.on("goaway", () => forget(environment, session));
			session.on("close", () => forget(environment, session));
			open.set(environment, session);
			return session;
		},
		closeAll() {
			for (const session of open.values()) session.close();
			open.clear();
		},
	};
}

/**
 * Sends one request on `session`, answering its status and body. It always
 * settles: a request that goes `timeoutMs` without a word takes the whole
 * connection down, since a silent connection is usually a dead one, and every
 * request on it then fails rather than waits.
 */
function post(
	session: ClientHttp2Session,
	headers: Record<string, string>,
	body: string,
	{ signal, timeoutMs }: { signal: AbortSignal; timeoutMs: number },
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const stream = session.request(headers, { signal });
		let status = 0;
		let answered = false;
		const chunks: Buffer[] = [];
		stream.setTimeout(timeoutMs, () => {
			// Failed first: dropping the connection ends the stream, which would otherwise read as an answer.
			reject(new Error(`The push service went ${timeoutMs} ms without answering.`));
			session.destroy();
		});
		stream.on("response", (response) => {
			status = Number(response[constants.HTTP2_HEADER_STATUS]);
		});
		stream.on("data", (chunk: Buffer) => chunks.push(chunk));
		stream.on("end", () => {
			answered = true;
			resolve({ status, body: Buffer.concat(chunks).toString("utf8") });
		});
		stream.on("error", reject);
		stream.on("close", () => {
			if (!answered) reject(new Error("The push service closed the request before answering."));
		});
		stream.end(body);
	});
}
