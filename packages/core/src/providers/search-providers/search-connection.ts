import type { SearchProviderPresetId } from "@sugabots/contracts";

/** What the `web_search` backend needs to call the workspace's search service. */
export interface SearchConnection {
	preset: SearchProviderPresetId;
	baseUrl: string;
	apiKey?: string;
	/** So a test result is recorded against the configuration it tested. */
	configurationUpdatedAt: Date;
}
