import { Schema } from "effect";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

/**
 * A person's computer running the desktop app, and what it lends: agents it
 * hosts, such as Claude Code working in a folder, which bots can stand for
 * over A2A without anything on the computer being reachable from the network.
 * The desktop dials out to the server and answers each request itself.
 *
 * Lending is asked for from the web app but decided on the computer: the
 * desktop asks its owner there, natively, and only its answer lends an agent.
 */

/** Where the desktop asks to be paired, without a session. Under the API's base path. */
export const DEVICE_PAIRINGS_PATH = "/device-pairings";

/** The WebSocket a paired desktop keeps open, with its token as a bearer token. Under the API's base path. */
export const DEVICE_LINK_PATH = "/devices/link";

/**
 * What the desktop app sets on its app window, and announces with an event of
 * the same name, so the web app knows it is running there and on which of the
 * person's devices. Only the desktop's own window offers lending, and only
 * this device's agents. It hides and shows UI; it grants nothing.
 */
export const DESKTOP_DEVICE_GLOBAL = "sugabotsDesktopDevice";

/** The web app's page where a signed-in person approves a pairing. */
export const DEVICE_PAIRING_PAGE = "/pair-device";

/** The kinds of agent a desktop knows how to host. */
export const localAgentKindSchema = Schema.Literals(["claude-code", "opencode"]);

export type LocalAgentKind = typeof localAgentKindSchema.Type;

/** An agent a desktop lends: the address it answers at through the device, and what it is. */
export const localAgentSchema = Schema.Struct({
	url: Schema.String,
	kind: localAgentKindSchema,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	/** The folder on the computer it works in. */
	workingDirectory: Schema.String,
});

export type LocalAgent = typeof localAgentSchema.Type;

/** An agent program found on the computer, which the desktop can lend in a folder. */
export const installedAgentSchema = Schema.Struct({
	kind: localAgentKindSchema,
	name: Schema.String,
	version: Schema.NullOr(Schema.String),
});

export type InstalledAgent = typeof installedAgentSchema.Type;

/** What a connected desktop lends, and what it could. */
export const deviceAgentsSchema = Schema.Struct({
	lent: Schema.Array(localAgentSchema),
	installed: Schema.Array(installedAgentSchema),
});

export type DeviceAgents = typeof deviceAgentsSchema.Type;

export const deviceSchema = Schema.Struct({
	id: uuidSchema,
	name: Schema.String,
	/** What it lends and could, while it's connected; null while it isn't. */
	agents: Schema.NullOr(deviceAgentsSchema),
	createdAt: isoTimestampSchema,
});

/** Asking a device to lend an agent of `kind`; its owner chooses the folder, on the device. */
export const lendRequestSchema = Schema.Struct({ kind: localAgentKindSchema });

/** Asking a device to stop lending the agent at `url`. */
export const stopLendingRequestSchema = Schema.Struct({ url: Schema.String });

export type Device = typeof deviceSchema.Type;

/**
 * A desktop asking to be paired. It makes its own token and sends only the
 * token's SHA-256, hex, so whoever approves the code pairs exactly the
 * desktop that holds it, and the token never travels before it's needed.
 */
export const devicePairingRequestSchema = Schema.Struct({
	name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
	tokenDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});

export type DevicePairingRequest = typeof devicePairingRequestSchema.Type;

/** The code a desktop shows, and opens the approval page with. */
export const devicePairingCodeSchema = Schema.Struct({ code: Schema.String });

/** A pairing waiting for somebody to approve it. */
export const pendingDevicePairingSchema = Schema.Struct({
	code: Schema.String,
	name: Schema.String,
});

export type PendingDevicePairing = typeof pendingDevicePairingSchema.Type;

/** A Sugabots tool offered to a lent agent while it answers a turn. */
export const offeredToolSchema = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	/** Its input, as JSON Schema. */
	inputSchema: Schema.Unknown,
});

export type OfferedTool = typeof offeredToolSchema.Type;

/** Which turn a lent agent's tool use belongs to: its address, and the A2A context it was asked in. */
const askedInSchema = { agentUrl: Schema.String, contextId: Schema.String };

/** A header and its value, in the order sent. */
const headersSchema = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));

/** Bytes, as base64. */
const bytesSchema = Schema.String;

/**
 * What the server sends down a device's link: an HTTP request for one of the
 * agents it lends, and calling one off. `id` pairs a request with what the
 * device sends back about it.
 */
export const serverToDeviceSchema = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("request"),
		id: Schema.String,
		method: Schema.String,
		url: Schema.String,
		headers: headersSchema,
		body: Schema.NullOr(bytesSchema),
	}),
	Schema.Struct({ type: Schema.Literal("cancel"), id: Schema.String }),
	/** Sent first: which device the server knows this link as. */
	Schema.Struct({ type: Schema.Literal("hello"), deviceId: Schema.String }),
	/** Asks the owner to lend an agent of `kind`; answered by "lent" with the same id. */
	Schema.Struct({ type: Schema.Literal("lend"), id: Schema.String, kind: localAgentKindSchema }),
	Schema.Struct({ type: Schema.Literal("stopLending"), url: Schema.String }),
	/** The answer to "listTools": none when no turn is asking that agent in that context. */
	Schema.Struct({
		type: Schema.Literal("tools"),
		id: Schema.String,
		tools: Schema.Array(offeredToolSchema),
	}),
	/** The answer to "callTool": what the tool said, as text. */
	Schema.Struct({
		type: Schema.Literal("toolResult"),
		id: Schema.String,
		text: Schema.String,
		isError: Schema.Boolean,
	}),
]);

export type ServerToDevice = typeof serverToDeviceSchema.Type;

/**
 * What a device sends up its link: what it lends and could, whenever that
 * changes, its owner's answer to being asked to lend, and each request's response as a head, body chunks and an end, or a failure.
 */
export const deviceToServerSchema = Schema.Union([
	Schema.Struct({ type: Schema.Literal("agents"), agents: deviceAgentsSchema }),
	/** The owner's answer to "lend": the agent lent, or null when they declined. */
	Schema.Struct({
		type: Schema.Literal("lent"),
		id: Schema.String,
		agent: Schema.NullOr(localAgentSchema),
	}),
	Schema.Struct({
		type: Schema.Literal("response"),
		id: Schema.String,
		status: Schema.Int,
		headers: headersSchema,
	}),
	Schema.Struct({ type: Schema.Literal("body"), id: Schema.String, chunk: bytesSchema }),
	Schema.Struct({ type: Schema.Literal("end"), id: Schema.String }),
	/** Which Sugabots tools the turn asking this agent, in this context, offers it. */
	Schema.Struct({ type: Schema.Literal("listTools"), id: Schema.String, ...askedInSchema }),
	/** Calls one of them; the server runs it in that turn. */
	Schema.Struct({
		type: Schema.Literal("callTool"),
		id: Schema.String,
		...askedInSchema,
		name: Schema.String,
		input: Schema.Unknown,
	}),
	Schema.Struct({ type: Schema.Literal("failed"), id: Schema.String, reason: Schema.String }),
]);

export type DeviceToServer = typeof deviceToServerSchema.Type;
