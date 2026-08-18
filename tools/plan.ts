// Installationsweg "Tool-Verzeichnis": Symlink dieser Datei nach
// ~/.config/opencode/tool/plan.ts ergibt das Tool plan_render (Dateiname plus
// Export-Name). Der reguläre Weg ist das Plugin, siehe src/plugin.ts.
export { planRenderTool as render } from "../src/tool.ts"
