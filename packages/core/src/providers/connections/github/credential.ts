import { Schema } from "effect";
import type { Credentials } from "../../../credentials/credentials.ts";

/** What a GitHub connection's app works with: its private key, and its webhook's signing secret. */
const GitHubAppCredential = Schema.Struct({
	privateKey: Schema.String,
	/** Null for an app made without a webhook. */
	webhookSecret: Schema.NullOr(Schema.String),
});
export type GitHubAppCredential = typeof GitHubAppCredential.Type;

const GitHubAppCredentialJson = Schema.fromJsonString(GitHubAppCredential);

/** Sealed for this use alone, so no other sealed value can be passed off as an app's credential. */
const SEALING_PURPOSE = "github-app-credential";

export function sealAppCredential(
	credentials: Credentials.Interface,
	credential: GitHubAppCredential,
) {
	return credentials.encrypt(
		Schema.encodeSync(GitHubAppCredentialJson)(credential),
		SEALING_PURPOSE,
	);
}

export function openAppCredential(
	credentials: Credentials.Interface,
	sealed: string,
): GitHubAppCredential {
	return Schema.decodeSync(GitHubAppCredentialJson)(credentials.decrypt(sealed, SEALING_PURPOSE));
}
