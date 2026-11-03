/**
 * What one of the app's generators produces: each file's contents by its path
 * under `apps/ios`, and the folder it owns outright, if any, where a file it no
 * longer produces is stale and removed.
 */
export interface GeneratedFiles {
	files: Map<string, string>;
	folder?: string;
}
