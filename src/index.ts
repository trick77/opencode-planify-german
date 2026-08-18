// Paket-Einstieg für OpenCode. Hier darf ausschliesslich die Plugin-Funktion
// stehen: OpenCode ruft jeden Export dieses Moduls als Plugin auf und bricht mit
// "Plugin export is not a function" ab, sobald etwas anderes exportiert wird.
// Renderer und Tool importiert man direkt aus planify/src/render.ts
// beziehungsweise planify/src/tool.ts.
export { PlanifyPlugin } from "./plugin.ts"
