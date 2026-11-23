/**
 * Where the bearer token lives between requests.
 *
 * TokenStore is synchronous because request headers read it synchronously.
 * Async stores such as React Native AsyncStorage and OS keychains cannot
 * implement it directly; those runtimes need a synchronous memory cache that
 * loads from and writes through to secure storage outside this interface.
 */

export interface TokenStore {
	get(): string | undefined;
	set(token: string | undefined): void;
}

export function memoryTokenStore(initial?: string): TokenStore {
	let token = initial;
	return {
		get: () => token,
		set: (value) => {
			token = value;
		},
	};
}
