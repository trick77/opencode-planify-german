// Nur Typen aus @opencode/plugin: das Paket ist Dev-Dependency, zur Laufzeit zieht
// das Plugin nichts davon nach (Plugin.define gibt die Definition ohnehin unverändert zurück).
import type { Plugin } from "@opencode/plugin"
import { createPlanRenderTool, type DirectoryResolver } from "./tool.ts"
import { createPrSummaryTool } from "./tool-pr.ts"

const stringOption = (value: unknown) => (typeof value === "string" ? value : undefined)

/**
 * Registriert die Tools `plan_render` und `pr_summary` (Plugin-API von opencode 2).
 * Installiert wird über den `plugins`-Eintrag in opencode.json.
 *
 * Optionen: `openWith` überschreibt das Kommando zum Öffnen der Plan-Datei, ohne
 * Angabe gewinnt der Standard-Handler des Systems (open, xdg-open, start).
 * `bitbucketUrl` und `bitbucketToken` braucht `pr_summary`.
 *
 * Relative Pfade und git-Abfragen gelten ab dem Verzeichnis der Sitzung, die das
 * Tool aufruft: der Aufruf bringt nur die sessionID mit, das Verzeichnis kommt pro
 * Aufruf aus `ctx.session.get`. Sitzungen können in eigenen Worktrees laufen, ein
 * beim Laden gemerktes Verzeichnis träfe dann den falschen Checkout. Nur wenn die
 * Sitzung nicht lesbar ist, gilt das Ladeverzeichnis des Plugins (`ctx.location`).
 */
const plugin: Plugin.Plugin = {
  id: "opencode-planify-german",
  async setup(ctx) {
    const directory: DirectoryResolver = async (context) => {
      try {
        return (await ctx.session.get({ sessionID: context.sessionID })).location.directory
      } catch {
        return ctx.location.directory
      }
    }
    const planRender = createPlanRenderTool({ directory, openWith: stringOption(ctx.options.openWith) })
    const prSummary = createPrSummaryTool({
      directory,
      bitbucketUrl: stringOption(ctx.options.bitbucketUrl),
      bitbucketToken: stringOption(ctx.options.bitbucketToken),
    })
    // Transforms spielt opencode wiederholt ab: die Tools darum vorher bauen, hier nur eintragen.
    await ctx.tool.transform((editor) => {
      editor.add(planRender)
      editor.add(prSummary)
    })
  },
}

export default plugin
