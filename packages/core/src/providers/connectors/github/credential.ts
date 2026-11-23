import { Schema } from "effect";
import type { Secrets } from "../../../secrets/secrets.ts";

/** What a GitHub connector's app works with: its private key, and its webhook's signing secret. */
const GitHubAppCredential = Schema.Struct({
	privateKey: Schema.String,
	/** Null for an app made without a webhook. */
	webhookSecret: Schema.NullOr(Schema.String),
});
type GitHubAppCredential = typeof GitHubAppCredential.Type;

const GitHubAppCredentialJson = Schema.fromJsonString(GitHubAppCredential);

/** Sealed for this use alone, so no other secret can be passed off as an app's credential. */
const SECRET_PURPOSE = "github-app-credential";

export function encryptAppCredential(secrets: Secrets.Interface, credential: GitHubAppCredential) {
	return secrets.encrypt(Schema.encodeSync(GitHubAppCredentialJson)(credential), SECRET_PURPOSE);
}

export function openAppCredential(secrets: Secrets.Interface, sealed: string): GitHubAppCredential {
	return Schema.decodeSync(GitHubAppCredentialJson)(secrets.decrypt(sealed, SECRET_PURPOSE));
}
