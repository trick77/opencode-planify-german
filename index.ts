// Einstieg für ein lokales Plugin-Verzeichnis (Repo-Checkout): opencode sucht dort nur
// <verzeichnis>/server.* oder <verzeichnis>/index.* und liest package.json nicht.
// Über npm geht der Weg via "exports" direkt nach src/index.ts.
export { default } from "./src/index.ts"
