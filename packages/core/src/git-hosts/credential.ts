import { Schema } from "effect";
import type { Credentials } from "../credentials/credentials.ts";

/**
 * What Sugabots works at a git host with, by the host's kind. A GitHub App's
 * private key mints short-lived tokens for the account it is installed on.
 */
export const GitHubAppCredential = Schema.Struct({
	kind: Schema.Literal("github"),
	appId: Schema.Int,
	/** The app's name in its github.com/apps/ address. */
	slug: Schema.String,
	privateKey: Schema.String,
	/** Null until the app is installed. */
	installationId: Schema.NullOr(Schema.Int),
	/** What GitHub signs the app's webhook deliveries with; null for an app made without a webhook. */
	webhookSecret: Schema.NullOr(Schema.String),
});
export type GitHubAppCredential = typeof GitHubAppCredential.Type;

export const Credential = Schema.Union([GitHubAppCredential]);
export type Credential = typeof Credential.Type;

export type GitHostKind = Credential["kind"];

const CredentialJson = Schema.fromJsonString(Credential);

export function sealed(credentials: Credentials.Interface, credential: Credential): string {
	return credentials.encrypt(Schema.encodeSync(CredentialJson)(credential));
}

export function unsealed(credentials: Credentials.Interface, encrypted: string): Credential {
	return Schema.decodeSync(CredentialJson)(credentials.decrypt(encrypted));
}
