/**
 * Where the build renders the not-found page. No route matches it, so it's the
 * same render the browser makes for any unknown address, and hydrates as one;
 * `server.ts` fails the build if a route ever does. Written to `404.html`,
 * which Cloudflare serves for addresses without a file. `worker.ts` answers
 * this address with a 404 too, since it has no page of its own.
 */
export const NOT_FOUND_PAGE_PATH = "/404";

/**
 * Sent with the build's request for the not-found page. `server.ts` answers it
 * with a 200, since the prerender keeps only pages that succeed. Only its
 * presence is checked.
 */
export const NOT_FOUND_PRERENDER_HEADER = "x-sugabots-prerender-not-found";
