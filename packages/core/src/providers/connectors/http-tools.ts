import type { ConnectorTool } from "@sugabots/contracts";

/**
 * An HTTP connector's tools, one per method, each a request under its
 * address. They are Sugabots' own, like GitHub's, so every HTTP connector
 * has the same ones: reads run, other requests wait for a member, and
 * deletes are off until someone chooses otherwise.
 */
export const HTTP_CONNECTOR_TOOLS: readonly ConnectorTool[] = [
	{ name: "get", description: "Send a GET request.", readOnly: true, destructive: false },
	{ name: "post", description: "Send a POST request.", readOnly: false, destructive: false },
	{ name: "put", description: "Send a PUT request.", readOnly: false, destructive: false },
	{ name: "patch", description: "Send a PATCH request.", readOnly: false, destructive: false },
	{ name: "delete", description: "Send a DELETE request.", readOnly: false, destructive: true },
];
