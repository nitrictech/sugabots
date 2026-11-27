import type { BuiltInSearchProviderId } from "@sugabots/contracts";

/** What `web_search` needs to call the workspace's search provider. */
export interface SearchProviderAccess {
	builtIn: BuiltInSearchProviderId;
	baseUrl: string;
	apiKey?: string;
	/** So a test result is recorded against the configuration it tested. */
	configurationUpdatedAt: Date;
}
