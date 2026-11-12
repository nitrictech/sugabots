/** Enough for a service's explanation, short of an error page it may answer with. */
const UPSTREAM_ERROR_CHARACTERS = 1_000;

/** Shorter values could be parts of ordinary words, which blanking would garble. */
const SHORTEST_CREDENTIAL_CHARACTERS = 8;

/** Such as `Bearer `: a service quoting a rejected credential quotes the token alone. */
const AUTHORIZATION_SCHEME = /^[A-Za-z]+\s+/;

/**
 * upstreamErrorText returns what a service said with an error, trimmed, cut
 * short, and with `credentials` blanked in case it quotes one back.
 */
export function upstreamErrorText(
	said: string,
	credentials: ReadonlyArray<string | undefined>,
): string {
	const blanked = credentials
		.flatMap((credential) =>
			credential ? [credential, credential.replace(AUTHORIZATION_SCHEME, "")] : [],
		)
		.filter((credential) => credential.length >= SHORTEST_CREDENTIAL_CHARACTERS)
		.reduce((text, credential) => text.replaceAll(credential, "…"), said);
	return blanked.trim().slice(0, UPSTREAM_ERROR_CHARACTERS);
}
