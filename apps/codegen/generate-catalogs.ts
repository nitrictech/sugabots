/**
 * Writes `Sugabots/API/Catalogs.generated.swift` (and the mute lengths in
 * `Sugabots/Home/Mutes.generated.swift`) from the catalogs and words
 * the web's settings and routine pages show, so the app lists and names them
 * as the web does: the search and computer providers, who makes a model,
 * notification levels and how long a mute lasts, workspace roles, a tool's
 * access, a webhook's senders and checks, a repository's events, and the
 * hues of the usage breakdown.
 *
 * They come from `@sugabots/contracts` and from the web's plain data modules
 * in `packages/web/src/lib`, which import nothing but types.
 */
import { REPOSITORY_EVENTS } from "../../packages/contracts/src/github.ts";
import { WEBHOOK_SECRET_PREFIXES } from "../../packages/contracts/src/routines.ts";
import {
	SANDBOX_E2B_DEFAULT_SIZE,
	sandboxProviderCatalog,
} from "../../packages/contracts/src/sandbox-providers.ts";
import {
	DEFAULT_SEARCH_PRESET,
	searchProviderCatalog,
} from "../../packages/contracts/src/search-providers.ts";
import {
	WORKSPACE_ROLES,
	workspaceRoleDescription,
	workspaceRoleLabel,
} from "../../packages/contracts/src/workspaces.ts";
import { MODEL_MAKER_NAMES } from "../../packages/web/src/lib/model-makers.ts";
import {
	MUTE_LENGTHS,
	NOTIFICATION_LEVEL_LABELS,
	NOTIFICATION_LEVEL_NOTES,
} from "../../packages/web/src/lib/notification-choices.ts";
import { PROVIDER_HUES } from "../../packages/web/src/lib/provider-hues.ts";
import {
	REPOSITORY_EVENT_LABELS,
	WEBHOOK_ALGORITHM_OPTIONS,
	WEBHOOK_AUTH_OPTIONS,
	WEBHOOK_ENCODING_OPTIONS,
	WEBHOOK_SECRET_LABELS,
	WEBHOOK_SOURCE_LABELS,
	WEBHOOK_SOURCE_SECRET_PLACEHOLDERS,
} from "../../packages/web/src/lib/routine-trigger-words.ts";
import { TOOL_ACCESS_LABELS } from "../../packages/web/src/lib/tool-access-labels.ts";
import { camelCase } from "./api/naming.ts";
import type { GeneratedFiles } from "./generated-files.ts";

/** Everything the generated file holds, as data, for each app's copy to be written from. */
export const catalogs = {
	searchProviders: searchProviderCatalog,
	defaultSearchProvider: DEFAULT_SEARCH_PRESET,
	sandboxProviders: sandboxProviderCatalog,
	sandboxDefaultSize: SANDBOX_E2B_DEFAULT_SIZE,
	modelMakerNames: MODEL_MAKER_NAMES,
	notificationLevelLabels: NOTIFICATION_LEVEL_LABELS,
	notificationLevelNotes: NOTIFICATION_LEVEL_NOTES,
	muteLengths: MUTE_LENGTHS,
	workspaceRoleLabels: Object.fromEntries(
		WORKSPACE_ROLES.map((role) => [role, workspaceRoleLabel(role)]),
	),
	workspaceRoleDescriptions: Object.fromEntries(
		WORKSPACE_ROLES.map((role) => [role, workspaceRoleDescription(role)]),
	),
	toolAccessLabels: TOOL_ACCESS_LABELS,
	webhookSourceLabels: WEBHOOK_SOURCE_LABELS,
	webhookSourceOptions: Object.entries(WEBHOOK_SOURCE_LABELS).map(([value, label]) => ({
		value,
		label,
	})),
	webhookSourceSecretPlaceholders: WEBHOOK_SOURCE_SECRET_PLACEHOLDERS,
	webhookSecretPrefixes: WEBHOOK_SECRET_PREFIXES,
	webhookAuthOptions: WEBHOOK_AUTH_OPTIONS,
	webhookAlgorithmOptions: WEBHOOK_ALGORITHM_OPTIONS,
	webhookEncodingOptions: WEBHOOK_ENCODING_OPTIONS,
	webhookSecretLabels: WEBHOOK_SECRET_LABELS,
	repositoryEvents: REPOSITORY_EVENTS.map((value) => ({
		value,
		label: REPOSITORY_EVENT_LABELS[value],
	})),
	providerHues: PROVIDER_HUES,
};

const string = (text: string) => JSON.stringify(text);

/** A record as a Swift dictionary literal, an entry a line, indented by `depth` tabs. */
function dictionary(record: Readonly<Record<string, string>>, depth: number): string {
	const indent = "\t".repeat(depth);
	const entries = Object.entries(record).map(
		([key, value]) => `${indent}\t${string(key)}: ${string(value)},`,
	);
	return `[\n${entries.join("\n")}\n${indent}]`;
}

/**
 * A Swift computed property of `type` called `name`, switching over each case
 * of an enum the API generator makes, with `record`'s entry for each case's raw
 * value. A value the API adds is a new case, which fails to compile here until
 * `record` has an entry for it. A value from a newer server, the enum's
 * `unknown` case, takes `unknownValue`, a Swift expression in which
 * `rawValue` is that value.
 */
function switchProperty(
	name: string,
	type: string,
	record: Readonly<Record<string, string>>,
	unknownValue: string,
): string {
	const values = Object.keys(record);
	// As the API generator names the case that holds a value it doesn't know.
	const unknownCase = values.some((value) => camelCase(value) === "unknown")
		? "unrecognized"
		: "unknown";
	const cases = Object.entries(record).map(
		([value, text]) => `\t\tcase .${camelCase(value)}: ${string(text)}`,
	);
	return [
		`\tvar ${name}: ${type} {`,
		"\t\tswitch self {",
		...cases,
		`\t\tcase .${unknownCase}: ${unknownValue}`,
		"\t\t}",
		"\t}",
	].join("\n");
}

/** Choices as a Swift array of `(value:label:)` tuples. */
function options(choices: readonly { value: string; label: string }[]): string {
	const entries = choices.map(({ value, label }) => `(${string(value)}, ${string(label)})`);
	return `[${entries.join(", ")}]`;
}

function muteDuration({ label, length }: (typeof MUTE_LENGTHS)[number]): string {
	const swiftLength =
		"minutes" in length
			? `.minutes(${length.minutes})`
			: `.tomorrow(atHour: ${length.tomorrowAtHour})`;
	return `\t\tMuteDuration(label: ${string(label)}, length: ${swiftLength}),`;
}

export function swift(data: typeof catalogs): string {
	return `// Generated by apps/codegen/generate-catalogs.ts from @sugabots/contracts and packages/web/src/lib. Do not edit.
import Foundation

/// A search provider in the catalog, as \`searchProviderCatalog\`.
struct SearchPreset {
	let id: String
	let name: String
	let baseUrl: String
	/// A server you run, rather than one with a fixed address.
	let local: Bool
	let requiresApiKey: Bool
	/// What it is good for, in the line under its name.
	let description: String

	static let catalog = [
${data.searchProviders.map((preset) => `\t\tSearchPreset(id: ${string(preset.id)}, name: ${string(preset.name)}, baseUrl: ${string(preset.baseUrl)}, local: ${preset.hosting === "local"}, requiresApiKey: ${preset.requiresApiKey}, description: ${string(preset.description)}),`).join("\n")}
	]

	/// \`DEFAULT_SEARCH_PRESET\`: the provider a workspace has until it chooses another.
	static let defaultId = ${string(data.defaultSearchProvider)}
}

/// A computer provider in the catalog, as \`sandboxProviderCatalog\`.
struct SandboxPreset {
	let id: String
	let name: String
	/// The address a local preset is usually at; nil for one with its own.
	let baseUrl: String?
	/// What computers are made from: an image, or a template.
	let imageLabel: String
	let defaultImage: String
	/// What it is good for, in the line under its name.
	let description: String

	static let catalog = [
${data.sandboxProviders.map((preset) => `\t\tSandboxPreset(id: ${string(preset.id)}, name: ${string(preset.name)}, baseUrl: ${preset.baseUrl === undefined ? "nil" : string(preset.baseUrl)}, imageLabel: ${string(preset.imageLabel)}, defaultImage: ${string(preset.defaultImage)}, description: ${string(preset.description)}),`).join("\n")}
	]

	/// \`SANDBOX_E2B_DEFAULT_SIZE\`.
	static let defaultSize = (cpuCount: ${data.sandboxDefaultSize.cpuCount}, memoryGiB: ${data.sandboxDefaultSize.memoryGiB})
}

extension ProviderModel {
	/// Who makes a model, by the name before its slash, as \`MODEL_MAKER_NAMES\`.
	static let makerNames: [String: String] = ${dictionary(data.modelMakerNames, 1)}
}

extension NotificationLevel {
	/// What the level is called where a person chooses one, as \`NOTIFICATION_LEVEL_LABELS\`.
${switchProperty("label", "String", data.notificationLevelLabels, string("Something else"))}

	/// What the level notifies about, as \`NOTIFICATION_LEVEL_NOTES\`; nil for a level this app doesn't know.
${switchProperty("note", "String?", data.notificationLevelNotes, "nil")}
}

extension WorkspaceRole {
	/// What the role is called, as \`workspaceRoleLabel\`.
${switchProperty("label", "String", data.workspaceRoleLabels, "rawValue.capitalized")}

	/// What the role may do, as \`workspaceRoleDescription\`.
${switchProperty("description", "String", data.workspaceRoleDescriptions, string(""))}
}

extension ConnectionAccess {
	/// The setting in words, as \`TOOL_ACCESS_LABELS\`.
${switchProperty("words", "String", data.toolAccessLabels, "rawValue")}
}

extension WebhookAuthChoice {
	/// Any sender, then each source that signs its own way, as \`WEBHOOK_SOURCE_LABELS\`.
	static let sourceOptions: [(value: String, label: String)] = ${options(data.webhookSourceOptions)}

	/// What each of \`sourceOptions\` is called, by its value.
	static let sourceLabels: [String: String] = ${dictionary(data.webhookSourceLabels, 1)}

	/// How each source's signing secret looks, as \`WEBHOOK_SOURCE_SECRET_PLACEHOLDERS\`.
	static let sourceSecretPlaceholders: [String: String] = ${dictionary(data.webhookSourceSecretPlaceholders, 1)}

	/// How the secrets of each kind start, or "" for any, as \`WEBHOOK_SECRET_PREFIXES\`.
	static let secretPrefixes: [String: String] = ${dictionary(data.webhookSecretPrefixes, 1)}

	/// \`WEBHOOK_AUTH_OPTIONS\`.
	static let authOptions: [(value: String, label: String)] = ${options(data.webhookAuthOptions)}
	/// \`WEBHOOK_ALGORITHM_OPTIONS\`.
	static let algorithmOptions: [(value: String, label: String)] = ${options(data.webhookAlgorithmOptions)}
	/// \`WEBHOOK_ENCODING_OPTIONS\`.
	static let encodingOptions: [(value: String, label: String)] = ${options(data.webhookEncodingOptions)}

	/// What each generic kind calls its secret, as \`WEBHOOK_SECRET_LABELS\`.
	static let secretLabels: [String: String] = ${dictionary(data.webhookSecretLabels, 1)}
}

extension RepositoryDraft {
	/// Each event in the order the switches list them, as \`REPOSITORY_EVENTS\`, with what its switch says.
	static let events: [(value: String, label: String)] = [
${data.repositoryEvents.map(({ value, label }) => `\t\t(${string(value)}, ${string(label)}),`).join("\n")}
	]
}

extension WorkspaceUsage {
	/// The pod colours each provider's models take in turn on the breakdown, as \`PROVIDER_HUES\`.
	static let providerHues = [${data.providerHues.map(string).join(", ")}]
}
`;
}

/**
 * The pauses and mutes offered, apart from the rest so the rule checks, which
 * build Foundation-only files, can build it beside `Home/Mutes.swift`.
 */
export function mutesSwift(data: typeof catalogs): string {
	return `// Generated by apps/codegen/generate-catalogs.ts from packages/web/src/lib. Do not edit.
import Foundation

extension MuteDuration {
	/// The pauses and mutes offered, as \`MUTE_LENGTHS\`.
	static let all = [
${data.muteLengths.map(muteDuration).join("\n")}
	]
}
`;
}

export function generate(): GeneratedFiles {
	return {
		files: new Map([
			["Sugabots/API/Catalogs.generated.swift", swift(catalogs)],
			["Sugabots/Home/Mutes.generated.swift", mutesSwift(catalogs)],
		]),
	};
}
