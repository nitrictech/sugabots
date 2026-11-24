/**
 * The providers operations' contracts, and their entries in the exposure manifest.
 * `index.ts` spreads both, so adding an operation here touches no other file.
 */

import { Schema } from "effect";
import { ActionForbidden, ResourceHidden } from "../errors/proofs.ts";
import {
	DiscoveryAddressRefused,
	DiscoveryCredentialsMissing,
	DiscoveryCredentialsRejected,
	DiscoverySignInLapsed,
	DiscoveryUnavailable,
	DiscoveryUnreachable,
	FetchedModelCapabilitiesImmutable,
	ModelInUse,
	ModelListTooLarge,
	ModelListUnreadable,
	ModelNotEnabled,
	ModelProviderNameConflict,
	ModelProviderNotFound,
	ModelProviderRemovalNotAllowed,
	ProviderActivationRequiresCredential,
	ProviderModelAlreadyConfigured,
	ProviderModelNotFound,
	ProviderModelsRequireCredential,
	ProviderSignInAttemptInvalid,
	ProviderSignInFailed,
	ProviderSignInNotOffered,
	SearchProviderApiKeyRequired,
	SearchProviderNotFound,
	UrlNotAllowed,
} from "../errors/providers.ts";
import {
	defaultModelUpdateSchema,
	modelProviderSchema,
	modelProviderUpdateSchema,
	newModelProviderSchema,
	newProviderModelSchema,
	providerModelSwitchOffSchema,
	providerModelUpdateSchema,
	providerSignInCompletionSchema,
	providerSignInOutcomeSchema,
	providerSignInStartedSchema,
	providerSwitchOffSchema,
	providerTestResultSchema,
	workspaceModelsResponseSchema,
} from "../model-providers.ts";
import {
	newSearchProviderSchema,
	searchProviderResponseSchema,
	searchProviderSchema,
	searchProviderTestResultSchema,
	searchProviderUpdateSchema,
	webAccessSchema,
} from "../search-providers.ts";
import { uuidSchema } from "../uuid.ts";
import { workspaceIdOrSlugSchema } from "../workspaces.ts";
import type { DomainExposure } from "./exposure.ts";
import { OperationContract } from "./operation.ts";

/** How an operation that proves what it may do in a workspace refuses. */
const workspaceRefusals = [ResourceHidden, ActionForbidden] as const;

/** Why asking a provider for its models failed. */
const discoveryFailures = [
	DiscoveryCredentialsMissing,
	DiscoveryCredentialsRejected,
	DiscoverySignInLapsed,
	DiscoveryUnavailable,
	DiscoveryUnreachable,
	DiscoveryAddressRefused,
	ModelListUnreadable,
	ModelListTooLarge,
] as const;

/** A workspace, by its id or its slug. */
const aWorkspace = { workspace: workspaceIdOrSlugSchema };

/** One of a workspace's model providers. */
const aProvider = { ...aWorkspace, providerId: uuidSchema };

/** One of a model provider's models, by the id of its row. */
const aModel = { ...aProvider, modelId: uuidSchema };

export const providersContracts = {
	"modelProviders.list": OperationContract.make("modelProviders.list", {
		description:
			"List the workspace's model providers, with their models, addresses and whether each is signed in.",
		input: Schema.Struct(aWorkspace),
		output: Schema.Array(modelProviderSchema),
		errors: workspaceRefusals,
		changes: false,
	}),
	"modelProviders.listEnabledModels": OperationContract.make("modelProviders.listEnabledModels", {
		description:
			"List the models the workspace offers bots, with what each may be used for, and the one new bots start on.",
		input: Schema.Struct(aWorkspace),
		output: workspaceModelsResponseSchema,
		errors: workspaceRefusals,
		changes: false,
	}),
	"modelProviders.setDefaultModel": OperationContract.make("modelProviders.setDefaultModel", {
		description: "Choose the model, which the workspace must offer, that its new bots start on.",
		input: Schema.Struct({ ...aWorkspace, ...defaultModelUpdateSchema.fields }),
		output: workspaceModelsResponseSchema,
		errors: [...workspaceRefusals, ModelNotEnabled],
		changes: true,
	}),
	"modelProviders.create": OperationContract.make("modelProviders.create", {
		description:
			"Add a model provider to the workspace, built in or at an address of its own. With a key, its models are listed and it is tried at once.",
		input: Schema.Struct({ ...aWorkspace, provider: newModelProviderSchema }),
		output: modelProviderSchema,
		errors: [...workspaceRefusals, UrlNotAllowed, ModelProviderNameConflict, ModelProviderNotFound],
		changes: true,
	}),
	"modelProviders.update": OperationContract.make("modelProviders.update", {
		description:
			"Change a model provider's key, address, headers or API format, or switch it on or off. A new key takes the place of a subscription sign-in.",
		input: Schema.Struct({ ...aProvider, changes: modelProviderUpdateSchema }),
		output: modelProviderSchema,
		errors: [
			...workspaceRefusals,
			ModelProviderNotFound,
			UrlNotAllowed,
			ProviderActivationRequiresCredential,
			ModelInUse,
		],
		changes: true,
	}),
	"modelProviders.remove": OperationContract.make("modelProviders.remove", {
		description: "Remove a custom model provider, with its models, from the workspace.",
		input: Schema.Struct(aProvider),
		output: Schema.Void,
		errors: [...workspaceRefusals, ModelProviderRemovalNotAllowed, ModelInUse],
		changes: true,
	}),
	"modelProviders.switchOff": OperationContract.make("modelProviders.switchOff", {
		description:
			"Switch a model provider off, moving the bots on its models, and the workspace's default and system bots, to models other providers offer.",
		input: Schema.Struct({ ...aProvider, ...providerSwitchOffSchema.fields }),
		output: Schema.Void,
		errors: [...workspaceRefusals, ModelProviderNotFound, ModelNotEnabled, ModelInUse],
		changes: true,
	}),
	"modelProviders.test": OperationContract.make("modelProviders.test", {
		description:
			"Try a model provider by listing its models, which costs nothing, and record whether it answered.",
		input: Schema.Struct(aProvider),
		output: providerTestResultSchema,
		errors: [...workspaceRefusals, ModelProviderNotFound],
		changes: true,
	}),
	"modelProviders.startSignIn": OperationContract.make("modelProviders.startSignIn", {
		description:
			"Start signing a model provider in with your subscription: get the code to enter at the provider's sign-in page.",
		input: Schema.Struct(aProvider),
		output: providerSignInStartedSchema,
		errors: [
			...workspaceRefusals,
			ModelProviderNotFound,
			ProviderSignInNotOffered,
			ProviderSignInFailed,
		],
		changes: false,
	}),
	"modelProviders.completeSignIn": OperationContract.make("modelProviders.completeSignIn", {
		description:
			"Ask whether the code of a sign-in you started has been entered. Once it has, the provider is signed in as you and its models are listed.",
		input: Schema.Struct({ ...aProvider, ...providerSignInCompletionSchema.fields }),
		output: providerSignInOutcomeSchema,
		errors: [
			...workspaceRefusals,
			ModelProviderNotFound,
			ProviderSignInNotOffered,
			ProviderSignInAttemptInvalid,
			ProviderSignInFailed,
		],
		changes: true,
	}),
	"modelProviders.signOut": OperationContract.make("modelProviders.signOut", {
		description: "Sign a model provider out of the subscription it signs in with.",
		input: Schema.Struct(aProvider),
		output: modelProviderSchema,
		errors: [...workspaceRefusals, ModelProviderNotFound, ProviderSignInNotOffered, ModelInUse],
		changes: true,
	}),
	"modelProviders.discoverModels": OperationContract.make("modelProviders.discoverModels", {
		description:
			"Ask a model provider which models it offers now, adding new ones and bringing changed ones up to date.",
		input: Schema.Struct(aProvider),
		output: Schema.Void,
		errors: [...workspaceRefusals, ...discoveryFailures],
		changes: true,
	}),
	"modelProviders.addModel": OperationContract.make("modelProviders.addModel", {
		description:
			"Add a model by hand to a model provider that has its key or sign-in, saying what it can do.",
		input: Schema.Struct({ ...aProvider, model: newProviderModelSchema }),
		output: modelProviderSchema,
		errors: [
			...workspaceRefusals,
			ModelProviderNotFound,
			ProviderModelsRequireCredential,
			ProviderModelAlreadyConfigured,
		],
		changes: true,
	}),
	"modelProviders.updateModel": OperationContract.make("modelProviders.updateModel", {
		description:
			"Switch one of a provider's models on or off, switch off capabilities bots may use, or change what a model added by hand can do.",
		input: Schema.Struct({ ...aModel, changes: providerModelUpdateSchema }),
		output: Schema.Void,
		errors: [
			...workspaceRefusals,
			ModelProviderNotFound,
			ProviderModelsRequireCredential,
			FetchedModelCapabilitiesImmutable,
			ProviderModelNotFound,
			ModelInUse,
		],
		changes: true,
	}),
	"modelProviders.switchOffModel": OperationContract.make("modelProviders.switchOffModel", {
		description:
			"Switch one of a provider's models off, moving the bots on it, and the workspace's default and system bots, to models the workspace still offers.",
		input: Schema.Struct({ ...aModel, ...providerModelSwitchOffSchema.fields }),
		output: Schema.Void,
		errors: [
			...workspaceRefusals,
			ModelProviderNotFound,
			ProviderModelsRequireCredential,
			ProviderModelNotFound,
			ModelNotEnabled,
			ModelInUse,
		],
		changes: true,
	}),
	"searchProviders.get": OperationContract.make("searchProviders.get", {
		description: "Show the workspace's search provider, if it has one.",
		input: Schema.Struct(aWorkspace),
		output: searchProviderResponseSchema,
		errors: workspaceRefusals,
		changes: false,
	}),
	"searchProviders.webAccess": OperationContract.make("searchProviders.webAccess", {
		description: "Say whether the workspace's bots are offered the web tools.",
		input: Schema.Struct(aWorkspace),
		output: webAccessSchema,
		errors: workspaceRefusals,
		changes: false,
	}),
	"searchProviders.replace": OperationContract.make("searchProviders.replace", {
		description: "Set the workspace's search provider, replacing the one it had.",
		input: Schema.Struct({ ...aWorkspace, ...newSearchProviderSchema.fields }),
		output: searchProviderSchema,
		errors: [...workspaceRefusals, UrlNotAllowed, SearchProviderApiKeyRequired],
		changes: true,
	}),
	"searchProviders.update": OperationContract.make("searchProviders.update", {
		description:
			"Change the workspace's search provider's key or address, or switch search on or off.",
		input: Schema.Struct({ ...aWorkspace, changes: searchProviderUpdateSchema }),
		output: searchProviderSchema,
		errors: [
			...workspaceRefusals,
			SearchProviderNotFound,
			UrlNotAllowed,
			SearchProviderApiKeyRequired,
		],
		changes: true,
	}),
	"searchProviders.remove": OperationContract.make("searchProviders.remove", {
		description:
			"Remove the workspace's search provider, which leaves its bots without web search.",
		input: Schema.Struct(aWorkspace),
		output: Schema.Void,
		errors: [...workspaceRefusals, SearchProviderNotFound],
		changes: true,
	}),
	"searchProviders.test": OperationContract.make("searchProviders.test", {
		description:
			"Try the workspace's search provider with a query, and record whether it answered.",
		input: Schema.Struct(aWorkspace),
		output: searchProviderTestResultSchema,
		errors: [...workspaceRefusals, SearchProviderNotFound],
		changes: true,
	}),
} as const;

/** Held back: managing the workspace's providers, which a bot may do only in member bounds. */
const managesProviders = {
	kind: "heldBack",
	reason:
		"It manages the workspace's providers, which a bot may do only in member bounds, and no tool does it yet.",
} as const;

/** Held back: it takes a key, which belongs in the web app's settings, not a chat a model reads. */
const takesKey = {
	kind: "heldBack",
	reason:
		"It takes an API key, which members enter in the web app's settings rather than in a chat a model reads.",
} as const;

/** Held back: a subscription sign-in is a member's own, made at the provider's page. */
const signsInAsMember = {
	kind: "heldBack",
	reason:
		"A subscription sign-in is a member's own: they enter its code at the provider's page, and it is recorded as theirs.",
} as const;

export const providersExposure = {
	"modelProviders.list": {
		http: { kind: "offered", endpoint: "modelProviders.list" },
		botLoop: managesProviders,
	},
	"modelProviders.listEnabledModels": {
		http: { kind: "offered", endpoint: "modelProviders.listEnabledModels" },
		botLoop: {
			kind: "heldBack",
			reason:
				"No tool lists the workspace's models; offering one waits for tools to become operations.",
		},
	},
	"modelProviders.setDefaultModel": {
		http: { kind: "offered", endpoint: "modelProviders.setDefaultModel" },
		botLoop: managesProviders,
	},
	"modelProviders.create": {
		http: { kind: "offered", endpoint: "modelProviders.create" },
		botLoop: takesKey,
	},
	"modelProviders.update": {
		http: { kind: "offered", endpoint: "modelProviders.update" },
		botLoop: takesKey,
	},
	"modelProviders.remove": {
		http: { kind: "offered", endpoint: "modelProviders.remove" },
		botLoop: managesProviders,
	},
	"modelProviders.switchOff": {
		http: { kind: "offered", endpoint: "modelProviders.switchOff" },
		botLoop: managesProviders,
	},
	"modelProviders.test": {
		http: { kind: "offered", endpoint: "modelProviders.test" },
		botLoop: managesProviders,
	},
	"modelProviders.startSignIn": {
		http: { kind: "offered", endpoint: "modelProviders.startSignIn" },
		botLoop: signsInAsMember,
	},
	"modelProviders.completeSignIn": {
		http: { kind: "offered", endpoint: "modelProviders.completeSignIn" },
		botLoop: signsInAsMember,
	},
	"modelProviders.signOut": {
		http: { kind: "offered", endpoint: "modelProviders.signOut" },
		botLoop: managesProviders,
	},
	"modelProviders.discoverModels": {
		http: { kind: "offered", endpoint: "modelProviders.discoverModels" },
		botLoop: managesProviders,
	},
	"modelProviders.addModel": {
		http: { kind: "offered", endpoint: "modelProviders.addModel" },
		botLoop: managesProviders,
	},
	"modelProviders.updateModel": {
		http: { kind: "offered", endpoint: "modelProviders.updateModel" },
		botLoop: managesProviders,
	},
	"modelProviders.switchOffModel": {
		http: { kind: "offered", endpoint: "modelProviders.switchOffModel" },
		botLoop: managesProviders,
	},
	"searchProviders.get": {
		http: { kind: "offered", endpoint: "searchProviders.get" },
		botLoop: managesProviders,
	},
	"searchProviders.webAccess": {
		http: { kind: "offered", endpoint: "searchProviders.webAccess" },
		botLoop: {
			kind: "heldBack",
			reason:
				"A bot is offered the web tools only while the workspace has web access, so it never needs to ask.",
		},
	},
	"searchProviders.replace": {
		http: { kind: "offered", endpoint: "searchProviders.replace" },
		botLoop: takesKey,
	},
	"searchProviders.update": {
		http: { kind: "offered", endpoint: "searchProviders.update" },
		botLoop: takesKey,
	},
	"searchProviders.remove": {
		http: { kind: "offered", endpoint: "searchProviders.remove" },
		botLoop: managesProviders,
	},
	"searchProviders.test": {
		http: { kind: "offered", endpoint: "searchProviders.test" },
		botLoop: managesProviders,
	},
} as const satisfies DomainExposure<typeof providersContracts>;
