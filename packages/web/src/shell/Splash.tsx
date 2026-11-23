/**
 * What shows while what a page needs first loads: the page's colour alone.
 * Deliberately not a spinner: it is one request against a local API, and a
 * spinner that flashes for 40ms reads as a fault.
 */
export function Splash() {
	return <div className="h-full bg-list" />;
}
