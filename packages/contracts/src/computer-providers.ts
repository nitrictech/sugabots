import { Schema } from "effect";
import { providerStatusSchema, providerUrlSchema } from "./model-providers.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

/**
 * Computer providers: where a workspace's projects get the Linux machines
 * their bots run commands on. Experimental.
 *
 * A workspace may configure several, each from a preset with its own account
 * and key, but at most one is enabled at a time, and that one makes every
 * project's computer, a bot's default project's included. Bots are offered
 * the computer tools only while one is.
 */

/**
 * Sugabots' computer image, from `docker/computer`: published to GHCR, or built
 * locally under the same name with `bun run build:computer`.
 */
export const COMPUTER_IMAGE = "ghcr.io/nitrictech/sugabots-sandbox:latest";

/**
 * The E2B template Sugabots builds from {@link COMPUTER_IMAGE} in a
 * workspace's E2B account. E2B makes computers from templates, not images.
 */
const COMPUTER_E2B_TEMPLATE = "sugabots-sandbox";

/**
 * Room to install a repository's dependencies and run its checks. E2B's own
 * default, 1 GiB, runs out doing that, and the computer stalls rather than failing.
 */
export const COMPUTER_E2B_DEFAULT_SIZE = { cpuCount: 2, memoryGiB: 4 } as const;

/**
 * The OpenSandbox SDK's own default. Docker refuses more vCPUs than its host
 * has, and Kubernetes reserves the whole size on a node, so a larger default
 * would stop computers starting on small hosts.
 */
export const COMPUTER_OPENSANDBOX_DEFAULT_SIZE = { cpuCount: 1, memoryGiB: 2 } as const;

/**
 * Bounds for a computer's size. The real limit is the E2B account's plan, or
 * what OpenSandbox's hosts have room for.
 */
export const computerCpuCountSchema = Schema.Int.check(
	Schema.isBetween({ minimum: 1, maximum: 64 }),
);
export const computerMemoryGiBSchema = Schema.Int.check(
	Schema.isBetween({ minimum: 1, maximum: 64 }),
);

const computerProviderPresetIdSchema = Schema.Literals(["opensandbox", "e2b"]);
export type ComputerProviderPresetId = typeof computerProviderPresetIdSchema.Type;

interface ComputerProviderPreset {
	id: ComputerProviderPresetId;
	name: string;
	/** A local preset is a server you run, at an address you give; a remote one has its own. */
	hosting: "remote" | "local";
	/** The address a local preset is usually at. */
	baseUrl?: string;
	/** What computers are made from: an image for OpenSandbox, a template for E2B. */
	imageLabel: string;
	defaultImage: string;
	/** The size of its computers unless the workspace sets another. */
	defaultSize: { readonly cpuCount: number; readonly memoryGiB: number };
	/** What it is good for, in the line under its name where one is chosen. */
	description: string;
}

export const computerProviderCatalog: readonly ComputerProviderPreset[] = [
	{
		id: "opensandbox",
		name: "OpenSandbox",
		hosting: "local",
		baseUrl: "http://localhost:8090",
		imageLabel: "Image",
		defaultImage: COMPUTER_IMAGE,
		defaultSize: COMPUTER_OPENSANDBOX_DEFAULT_SIZE,
		description: "Runs on your own Docker or Kubernetes",
	},
	{
		id: "e2b",
		name: "E2B",
		hosting: "remote",
		imageLabel: "Template",
		defaultImage: COMPUTER_E2B_TEMPLATE,
		defaultSize: COMPUTER_E2B_DEFAULT_SIZE,
		description: "Hosted microVMs, or E2B Embed on your own server",
	},
];

export function computerProviderPreset(id: ComputerProviderPresetId): ComputerProviderPreset {
	const preset = computerProviderCatalog.find((candidate) => candidate.id === id);
	if (!preset) {
		throw new Error(`Unknown computer provider preset: ${id}`);
	}
	return preset;
}

const apiKeySchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const nameSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(512));

/**
 * How a provider's computers reach the internet: `allowlist`, only the
 * trusted hosts and those the workspace and each project add; or `open`, every
 * host but those the workspace blocks, as far as the provider can refuse
 * hosts by name. E2B can't, so its open computers reach every host.
 */
const computerNetworkModeSchema = Schema.Literals(["allowlist", "open"]);

export type ComputerNetworkMode = typeof computerNetworkModeSchema.Type;

/** A provider whose settings leave out its network mode is open. */
export const COMPUTER_NETWORK_MODE_DEFAULT: ComputerNetworkMode = "open";

/**
 * An image's name as `docker pull` takes it, such as
 * `ghcr.io/nitrictech/sugabots-sandbox:edge`. This only catches what people
 * paste by mistake, a whole command or a web address, rather than every rule
 * of Docker's.
 */
const imageSchema = Schema.Trim.check(
	Schema.isMaxLength(512),
	Schema.isPattern(/^\S+$/, {
		message: "Enter just the image's name, such as ghcr.io/nitrictech/sugabots-sandbox:latest",
	}),
	Schema.isPattern(/^(?![a-z]+:\/\/)/i, {
		message:
			"Enter the image's name rather than a web address, such as ghcr.io/nitrictech/sugabots-sandbox:latest",
	}),
);

function providerSettingsWithImageSchema(image: Schema.Codec<string, string>) {
	return Schema.Union([
		Schema.Struct({
			preset: Schema.Literal("opensandbox"),
			serverUrl: Schema.optional(providerUrlSchema),
			image: Schema.optional(image),
			/** The most each computer may use. */
			cpuCount: Schema.optional(computerCpuCountSchema),
			memoryGiB: Schema.optional(computerMemoryGiBSchema),
			/** Left out, {@link COMPUTER_NETWORK_MODE_DEFAULT}. */
			networkMode: Schema.optional(computerNetworkModeSchema),
		}),
		Schema.Struct({
			preset: Schema.Literal("e2b"),
			/** E2B Embed's API and its address for reaching computers; both left out for E2B Cloud. */
			apiUrl: Schema.optional(providerUrlSchema),
			sandboxUrl: Schema.optional(providerUrlSchema),
			template: Schema.optional(nameSchema),
			/** What the template is built with, so every computer made from it has. */
			cpuCount: Schema.optional(computerCpuCountSchema),
			memoryGiB: Schema.optional(computerMemoryGiBSchema),
			/** Left out, {@link COMPUTER_NETWORK_MODE_DEFAULT}. Open, the workspace's blocks don't apply. */
			networkMode: Schema.optional(computerNetworkModeSchema),
		}),
	]);
}

/**
 * A provider's settings, by preset, as they are saved. A provider may be
 * saved before it has every address it needs; it can't be enabled until it
 * has. An image, template or size left out follows the default, so a new
 * default reaches every provider not set to something else.
 */
export const computerProviderSettingsSchema = providerSettingsWithImageSchema(imageSchema);

/**
 * Settings as they are read back. An image saved before images' names were
 * checked is shown as it is, so the page that would correct it still loads.
 * Its JSON is that of {@link computerProviderSettingsSchema}, so the API
 * document names it the same.
 */
const savedComputerProviderSettingsSchema = providerSettingsWithImageSchema(nameSchema).annotate({
	identifier: "ComputerProviderSettings",
});

export type ComputerProviderSettings = typeof computerProviderSettingsSchema.Type;

export const computerProviderSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	preset: computerProviderPresetIdSchema,
	name: Schema.String,
	settings: savedComputerProviderSettingsSchema,
	/** Whether this provider makes the workspace's computers. At most one is. */
	enabled: Schema.Boolean,
	status: providerStatusSchema,
	hasApiKey: Schema.Boolean,
	lastTestedAt: Schema.NullOr(isoTimestampSchema),
	lastTestError: Schema.NullOr(Schema.String),
	createdAt: isoTimestampSchema,
}).annotate({ identifier: "ComputerProvider" });

export type ComputerProvider = typeof computerProviderSchema.Type;

export const newComputerProviderSchema = Schema.Struct({
	/** Its preset is the provider's for good. */
	settings: computerProviderSettingsSchema,
	/** Enabling it disables whichever provider was enabled before. */
	enabled: Schema.optional(Schema.Boolean),
	apiKey: Schema.optional(apiKeySchema),
});

export type NewComputerProvider = typeof newComputerProviderSchema.Type;

export const computerProviderUpdateSchema = Schema.Struct({
	/** Enabling it disables whichever provider was enabled before. */
	enabled: Schema.optional(Schema.Boolean),
	/** Absent leaves the stored key alone; null removes it. */
	apiKey: Schema.optional(Schema.NullOr(apiKeySchema)),
	/** Replaces the settings whole; their preset must be the provider's. */
	settings: Schema.optional(computerProviderSettingsSchema),
}).check(
	Schema.makeFilter((value) => Object.keys(value).length > 0, { message: "Nothing to change" }),
);

export type ComputerProviderUpdate = typeof computerProviderUpdateSchema.Type;

/**
 * Whether the workspace's projects can be given a computer: true while it has an
 * enabled computer provider with everything it needs.
 */
export const computerAccessSchema = Schema.Struct({ enabled: Schema.Boolean });

export const computerProviderTestResultSchema = Schema.Struct({
	reachable: Schema.Boolean,
	latencyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	error: Schema.optional(Schema.String),
});

export type ComputerProviderTestResult = typeof computerProviderTestResultSchema.Type;

const byteCountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A folder of a project's computer and how much of its disk it takes. */
const computerDiskFolderSchema = Schema.Union([
	/** A bot's home, kept across all its conversations on the computer. */
	Schema.Struct({ kind: Schema.Literal("home"), botId: uuidSchema, bytes: byteCountSchema }),
	/** Every conversation's folder together, where the bots clone and build. Named for the folder, `threads/`, as computers keep it. */
	Schema.Struct({ kind: Schema.Literal("threads"), bytes: byteCountSchema }),
	/** `/tmp`. */
	Schema.Struct({ kind: Schema.Literal("temporary"), bytes: byteCountSchema }),
]);

export type ComputerDiskFolder = typeof computerDiskFolderSchema.Type;

/**
 * How full a project's computer's disk was when last measured, which it is every
 * few minutes while it runs. A paused computer's disk doesn't change, so its
 * last measurement still holds.
 */
const computerDiskSchema = Schema.Struct({
	usedBytes: byteCountSchema,
	/** What its files can fill: what they use and what is still free to them. */
	totalBytes: byteCountSchema,
	measuredAt: isoTimestampSchema,
	/** Largest first; null when they couldn't be sized, such as when it took too long. */
	folders: Schema.NullOr(Schema.Array(computerDiskFolderSchema)),
});

export type ComputerDisk = typeof computerDiskSchema.Type;

/** Past this share of its disk, a computer is close to full. */
export const COMPUTER_DISK_WARNING_SHARE = 0.8;
/** Past this share, commands that write are about to fail. */
const COMPUTER_DISK_CRITICAL_SHARE = 0.9;

/** The share of its disk a computer's files use, from 0 to 1. */
export function computerDiskShare(disk: Pick<ComputerDisk, "usedBytes" | "totalBytes">) {
	return disk.totalBytes === 0 ? 1 : Math.min(disk.usedBytes / disk.totalBytes, 1);
}

/** The share of its disk a computer's files use, as a whole percent, as people are shown it. */
export function computerDiskPercent(disk: Pick<ComputerDisk, "usedBytes" | "totalBytes">) {
	return Math.round(computerDiskShare(disk) * 100);
}

/** How full the disk is: `warning` and `critical` past their shares of it. */
export function computerDiskLevel(disk: Pick<ComputerDisk, "usedBytes" | "totalBytes">) {
	const share = computerDiskShare(disk);
	if (share >= COMPUTER_DISK_CRITICAL_SHARE) return "critical";
	if (share >= COMPUTER_DISK_WARNING_SHARE) return "warning";
	return "normal";
}

const BYTE_UNITS = ["bytes", "KB", "MB", "GB", "TB"] as const;
const BYTES_PER_KB = 1024;

/** A size on disk as people read one, in units of 1024: `512 KB`, `18.4 GB`. */
export function formatDiskSize(bytes: number) {
	const exponent = Math.min(
		Math.max(Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(BYTES_PER_KB)), 0),
		BYTE_UNITS.length - 1,
	);
	const value = bytes / BYTES_PER_KB ** exponent;
	const shown = exponent === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
	return `${shown} ${BYTE_UNITS[exponent]}`;
}

/** A project's computer as its settings show it, a bot's default project's in the bot's. */
const projectComputerStateSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("none") }),
	Schema.Struct({
		kind: Schema.Literal("present"),
		/** `lost`: the provider no longer has it. `unreachable`: its provider didn't answer. */
		state: Schema.Literals(["running", "paused", "lost", "unreachable"]),
		/** What it was made from, as its provider names it; null when the provider didn't answer. */
		image: Schema.NullOr(Schema.String),
		providerName: Schema.String,
		createdAt: isoTimestampSchema,
		lastUsedAt: isoTimestampSchema,
		turnsUsing: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		peopleWatching: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		/** Whether the workspace's enabled provider would make it from another image, or is another provider. */
		upgradeAvailable: Schema.Boolean,
		/** Null until it has been measured. */
		disk: Schema.NullOr(computerDiskSchema),
	}),
]);

export const projectComputerSchema = Schema.Struct({
	computer: projectComputerStateSchema,
	/** Whether the workspace has a computer provider enabled, without which nothing new is made. */
	providerEnabled: Schema.Boolean,
	/** Whether the person asking may reset or upgrade it. */
	canManage: Schema.Boolean,
});

export type ProjectComputer = typeof projectComputerSchema.Type;

/**
 * The disk of one project's computer, for the workspace's overview of its
 * computers. A bot's computer is its default project's.
 */
export const projectComputerDiskSchema = Schema.Struct({
	projectId: uuidSchema,
	disk: computerDiskSchema,
});

export type ProjectComputerDisk = typeof projectComputerDiskSchema.Type;

/**
 * How a provider's template stands, for a provider that builds its computers
 * from one (E2B): `missing` until Sugabots' is prepared in the workspace's
 * account. Null for a provider that takes images as they are.
 */
export const computerTemplateSchema = Schema.Struct({
	state: Schema.NullOr(Schema.Literals(["missing", "building", "ready", "failed"])),
});

/**
 * A host a computer may reach: a domain name such as `api.example.com`, or a
 * leading wildcard such as `*.example.com`, which covers the domain's
 * subdomains but not the domain itself. Lowercase. Addresses and ports aren't
 * hosts here: the providers' allowlists match names. Names for local networks
 * and services whose names resolve to any address someone writes in them
 * (`10-0-0-1.nip.io`) aren't either, since the providers allow whatever
 * address a name resolves to.
 */
export const computerHostSchema = Schema.String.check(
	Schema.isMaxLength(253),
	Schema.isPattern(
		/^(\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
		{ message: "Enter a domain name, such as api.example.com or *.example.com" },
	),
	Schema.isPattern(
		/^(?!(?:.*\.)?(?:internal|local|localhost|arpa|home|lan|nip\.io|sslip\.io|xip\.io|traefik\.me|localtest\.me|lvh\.me|localhost\.direct)$)/,
		{ message: "That name is for a local network, which computers can't reach" },
	),
);

/** A host a workspace let every computer reach, or a project its own, beyond the trusted ones. */
const computerAddedHostSchema = Schema.Struct({
	host: computerHostSchema,
	/** Who added it, or approved a bot's request for it; null once they've left. */
	addedByName: Schema.NullOr(Schema.String),
	addedAt: isoTimestampSchema,
});

export type ComputerAddedHost = typeof computerAddedHostSchema.Type;

/** A host no computer in the workspace may reach, whatever a project allows. */
const blockedHostSchema = Schema.Struct({
	host: computerHostSchema,
	/** Who blocked it; null once they've left. */
	blockedByName: Schema.NullOr(Schema.String),
});

export type BlockedHost = typeof blockedHostSchema.Type;

/**
 * What a workspace lets every computer connect to, and what it keeps them
 * all from. Each project adds its own hosts; everything else is refused, so
 * a command that reaches for another host fails as if it weren't there.
 */
export const computerNetworkSettingsSchema = Schema.Struct({
	/** The enabled provider's; {@link COMPUTER_NETWORK_MODE_DEFAULT} while none is enabled. */
	mode: computerNetworkModeSchema,
	/**
	 * Whether the blocked hosts are kept out: false while the computers are
	 * open at a provider that can't refuse hosts by name.
	 */
	blocking: Schema.Boolean,
	/** What every workspace's computers reach: package registries and where source code is hosted. */
	trustedHosts: Schema.Array(computerHostSchema),
	addedHosts: Schema.Array(computerAddedHostSchema),
	/**
	 * Out of every computer's reach, with their subdomains. A block also keeps out
	 * any allowed wildcard that covers it, since a computer can't be let into a
	 * wildcard with exceptions.
	 */
	blockedHosts: Schema.Array(blockedHostSchema),
});

export type ComputerNetworkSettings = typeof computerNetworkSettingsSchema.Type;

/** The workspace's block that keeps a host out of the computer's reach anyway; null when none does. */
const blockedBy = Schema.NullOr(computerHostSchema);

/** Where one project's computer may connect to: what the workspace allows every computer, and its own. */
export const projectComputerNetworkSchema = Schema.Struct({
	/** The workspace's enabled provider's; open, the computer reaches every host the workspace didn't block. */
	mode: computerNetworkModeSchema,
	/** Whether the workspace's blocked hosts are kept out of the computer. */
	blocking: Schema.Boolean,
	/** The trusted hosts and the workspace's, which every computer is allowed. */
	workspaceHosts: Schema.Array(Schema.Struct({ host: computerHostSchema, blockedBy })),
	/** What was added for the project's own computer. */
	addedHosts: Schema.Array(Schema.Struct({ ...computerAddedHostSchema.fields, blockedBy })),
});

export type ProjectComputerNetwork = typeof projectComputerNetworkSchema.Type;

export const newComputerHostSchema = Schema.Struct({ host: computerHostSchema });
