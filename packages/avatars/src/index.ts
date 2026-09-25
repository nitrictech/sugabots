/**
 * Bot faces and the colours bots wear, shared by the app and the website.
 *
 * Tailwind only generates classes it finds in scanned source, so an app that
 * renders these components must scan this package, e.g.
 * `@source "../../avatars/src";` in its stylesheet.
 */

export * from "./bot-colors.ts";
export * from "./bot-face.tsx";
export * from "./face-marks.ts";
