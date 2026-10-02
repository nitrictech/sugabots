/**
 * A deploy replaces every hashed chunk, so a tab opened before it fails to load
 * any chunk it has not fetched yet. This reloads the page when that happens,
 * which picks up the new `index.html` and its hashes. A second failure soon
 * after the reload is a chunk that is really missing, so it is left to fail
 * rather than reload forever. See https://vite.dev/guide/build#load-error-handling.
 *
 * The failed import still throws: the page is reloading, and suppressing the
 * error would hand its caller `undefined` to fail on instead.
 */
export function reloadWhenADeployReplacesChunks(): void {
	window.addEventListener("vite:preloadError", () => {
		const reloadedAt = Number(readReloadedAt());
		if (Date.now() - reloadedAt < RELOAD_COOLDOWN_MS) {
			return;
		}
		writeReloadedAt(String(Date.now()));
		window.location.reload();
	});
}

const RELOADED_AT_KEY = "stale-chunk-reloaded-at";
const RELOAD_COOLDOWN_MS = 10_000;

function readReloadedAt(): string | null {
	try {
		return sessionStorage.getItem(RELOADED_AT_KEY);
	} catch {
		return null;
	}
}

function writeReloadedAt(value: string): void {
	try {
		sessionStorage.setItem(RELOADED_AT_KEY, value);
	} catch {
		// Storage can be off. The reload still happens, only without the guard.
	}
}
