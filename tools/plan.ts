import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { tool } from "@opencode-ai/plugin"
import { dateiname, rendere, validiere } from "../src/render.ts"

const z = tool.schema

// Die verbindliche Pruefung macht ajv gegen skills/planify/schema/plan.schema.json.
// Diese zod-Form beschreibt dem Modell nur die Struktur.
const datei = z.object({
  path: z.string().describe("Pfad relativ zum Projekt, z. B. src/render.ts"),
  change: z.string().describe("Was genau geändert wird, ein Satz"),
})

const planForm = z.object({
  ticket: z.string().describe("Ticket-Key aus dem Branch, Muster [A-Z][A-Z0-9]+-[0-9]+"),
  slug: z.string().describe("Kurztitel in Kebab-Case, ASCII ohne Umlaute (nur für den Dateinamen)"),
  title: z.string().describe("Titel des Vorhabens, deutsch"),
  intent: z.string().describe("Ein Absatz: was gemacht wird und warum"),
  context: z
    .object({ problem: z.string(), outcome: z.string() })
    .optional()
    .describe("Problem und angestrebtes Ergebnis"),
  steps: z
    .array(
      z.object({
        title: z.string(),
        rationale: z.string().optional().describe("Warum dieser Schritt nötig ist"),
        files: z.array(datei).describe("Mindestens eine Datei mit exaktem Pfad"),
        commands: z.array(z.string()).optional(),
      }),
    )
    .describe("Umsetzungsschritte in Reihenfolge"),
  verification: z
    .array(z.object({ how: z.string(), expected: z.string() }))
    .describe("Wie wird Ende zu Ende geprüft, und was ist zu erwarten"),
  risks: z.array(z.object({ risk: z.string(), mitigation: z.string() })).optional(),
  openDecisions: z
    .array(z.object({ question: z.string(), recommendation: z.string(), tradeoff: z.string() }))
    .optional()
    .describe("Offene Entscheidungen des Benutzers, mit Empfehlung und Abwägung"),
  outOfScope: z.array(z.string()).optional(),
  diagram: z
    .object({ title: z.string(), caption: z.string().optional(), svgPath: z.string() })
    .optional()
    .describe("Nur wenn ein Diagramm Struktur zeigt, die die Prosa nicht trägt. SVG via Skill diagram-design erzeugen, Pfad hier eintragen; es wird inline eingebettet."),
  meta: z
    .object({
      createdAt: z.string().describe("ISO-8601 Zeitstempel"),
      model: z.string().optional(),
      branch: z.string().optional(),
      repo: z.string().optional(),
    })
    .describe("Metadaten des Plans"),
})

export const render = tool({
  description:
    "Rendert einen Plan aus JSON zu einer eigenständigen HTML-Datei (Nunjucks-Template, Anthropic-Anmutung) und öffnet sie in Safari. " +
    "Der einzige zulässige Weg, einen Plan auszugeben: niemals HTML oder Markdown selbst schreiben. " +
    "Ist der Plan nicht schemakonform, wird nichts geschrieben und die Feldfehler kommen zurück — dann korrigieren und erneut aufrufen. " +
    "Details zu Feldern und Schreibregeln: Skill \"planify\".",
  args: {
    plan: planForm.describe("Der vollständige Plan. Feldnamen englisch, Inhalte deutsch."),
    outDir: z
      .string()
      .optional()
      .describe("Zielverzeichnis, Standard docs/plans im Projekt"),
    open: z.boolean().optional().describe("HTML in Safari öffnen, Standard true"),
  },
  async execute(args, context) {
    const plan = args.plan as any
    const fehler = validiere(plan)
    if (fehler.length) {
      return [
        "Plan nicht geschrieben — Schema verletzt:",
        ...fehler.map((f) => `  ${f.pfad || "/"}: ${f.meldung}`),
        "",
        "Felder korrigieren und plan_render erneut aufrufen.",
      ].join("\n")
    }

    const ziel = resolve(context.directory, args.outDir ?? "docs/plans")
    mkdirSync(ziel, { recursive: true })
    const basis = dateiname(plan)
    const jsonPfad = resolve(ziel, `${basis}.plan.json`)
    const htmlPfad = resolve(ziel, `${basis}.html`)

    let ergebnis
    try {
      ergebnis = rendere(plan, { basis: context.directory })
    } catch (fehlerBeimRendern) {
      return `Plan nicht geschrieben — Rendern fehlgeschlagen: ${(fehlerBeimRendern as Error).message}`
    }

    writeFileSync(jsonPfad, JSON.stringify(plan, null, 2) + "\n", "utf8")
    writeFileSync(htmlPfad, ergebnis.html, "utf8")

    if (args.open !== false) {
      spawn("open", ["-a", "Safari", htmlPfad], { stdio: "ignore", detached: true }).unref()
    }

    context.metadata({ title: `${plan.ticket} — ${plan.title}`, metadata: { jsonPfad, htmlPfad } })

    const zeilen = [`Plan geschrieben:`, `  ${jsonPfad}`, `  ${htmlPfad}`]
    if (args.open !== false) zeilen.push("In Safari geöffnet.")
    if (ergebnis.warnungen.length) {
      zeilen.push("", "Warnungen zur Schreibweise (bitte im nächsten Zug korrigieren und neu rendern):")
      for (const w of ergebnis.warnungen) zeilen.push(`  ${w.pfad}: ${w.meldung}`)
    }
    return zeilen.join("\n")
  },
})
