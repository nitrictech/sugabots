/** The part of des.js the desktop's VNC authentication uses; it ships no types. */
declare module "des.js" {
	interface Cipher {
		update(data: Uint8Array): number[];
		final(): number[];
	}
	const des: {
		DES: {
			create(options: { type: "encrypt"; key: Uint8Array; padding: boolean }): Cipher;
		};
	};
	export default des;
}
