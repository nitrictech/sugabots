/** The bundler (Vite, in every app that uses this package) turns an imported SVG into its URL. */
declare module "*.svg" {
	const url: string;
	export default url;
}
