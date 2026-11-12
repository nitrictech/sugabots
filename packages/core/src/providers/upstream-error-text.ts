/** Enough for a service's explanation, short of an error page it may answer with. */
const UPSTREAM_ERROR_CHARACTERS = 1_000;

/** Real keys are longer; anything shorter could be part of ordinary words, which blanking would garble. */
const SHORTEST_CREDENTIAL_CHARACTERS = 8;

/** The scheme an Authorization value starts with, such as `Bearer `; a service echoes the token alone. */
const AUTHORIZATION_SCHEME = /^[A-Za-z]+\s+/;

/**
 * upstreamErrorText returns what a service said with an error, fit to pass on
 * to a bot and the people in its chat: trimmed, cut short, and with each of
 * `credentials` (what the service was sent to authenticate) blanked, because
 * a service may quote a key it rejected.
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
