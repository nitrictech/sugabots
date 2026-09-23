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

/**
 * UNSAFE: persists a bearer token in browser localStorage.
 * Same-origin JavaScript can read the token, so runtimes requiring an OS-backed
 * credential boundary must provide a different synchronous cached adapter.
 */
export function localStorageTokenStore(key = "sugabots.token"): TokenStore {
	let token: string | undefined;
	let storageFailed = false;

	return {
		get: () => {
			if (storageFailed) {
				return token;
			}
			try {
				token = localStorage.getItem(key) ?? undefined;
			} catch {
				storageFailed = true;
			}
			return token;
		},
		set: (value) => {
			token = value;
			if (storageFailed) {
				return;
			}
			try {
				if (value === undefined) {
					localStorage.removeItem(key);
				} else {
					localStorage.setItem(key, value);
				}
			} catch {
				storageFailed = true;
			}
		},
	};
}

/** Returns a non-persistent bearer token store. */
export function defaultTokenStore(): TokenStore {
	return memoryTokenStore();
}
