import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Info } from "@opencode/plugin/promise/tool"
import { buildOpenCommand } from "./open.ts"
import { baseName, render, validate } from "./render.ts"

// Die verbindliche Prüfung macht ajv gegen skills/planify/schema/plan.schema.json.
// Dieses JSON Schema beschreibt dem Modell nur die Struktur. Bewusst locker: opencode
// prüft die Eingabe vor execute, ein strenges Schema nähme ajv die Feldfehler weg.
const str = (description?: string) => (description ? { type: "string", description } : { type: "string" })

const obj = (properties: Record<string, object>, required: string[], description?: string) => ({
  type: "object",
  properties,
  required,
  ...(description ? { description } : {}),
})

const arr = (items: object, description?: string) => ({ type: "array", items, ...(description ? { description } : {}) })

const fileEntry = obj(
  {
    path: str("Pfad relativ zum Projekt, z. B. src/render.ts"),
    change: str("Was in dieser Datei passiert, ein Satz"),
  },
  ["path", "change"],
)

const planShape = obj(
  {
    ticket: str("Ticket-Key aus dem Branch, Muster [A-Z][A-Z0-9]+-[0-9]+"),
    slug: str("Kurztitel in Kebab-Case, ASCII ohne Umlaute (nur für den Dateinamen)"),
    title: str("Titel des Vorhabens, deutsch"),
    intent: str("Ein Absatz: was gemacht wird und warum"),
    context: obj(
      { problem: str(), outcome: str() },
      ["problem", "outcome"],
      "problem: was heute schiefgeht. outcome: Zustand nach der Umsetzung",
    ),
    steps: arr(
      obj(
        {
          title: str(),
          rationale: str("Warum der Schritt nötig ist. Nur wenn nicht offensichtlich"),
          files: arr(fileEntry, "Mindestens eine Datei mit exaktem Pfad"),
          commands: arr(str()),
        },
        ["title", "files"],
      ),
      "Umsetzungsschritte in Reihenfolge",
    ),
    verification: arr(
      obj({ how: str(), expected: str() }, ["how", "expected"]),
      "Ende-zu-Ende-Prüfung: how (Kommando oder Handgriff), expected (woran man Erfolg erkennt)",
    ),
    risks: arr(obj({ risk: str(), mitigation: str() }, ["risk", "mitigation"])),
    openDecisions: arr(
      obj({ question: str(), recommendation: str(), tradeoff: str() }, ["question", "recommendation", "tradeoff"]),
      "Offene Entscheidungen des Benutzers, mit Empfehlung und Abwägung. Nie still im Text entscheiden",
    ),
    outOfScope: arr(str()),
    diagram: obj(
      { title: str(), caption: str(), svgPath: str() },
      ["title", "svgPath"],
      "Nur wenn ein Diagramm Struktur zeigt, die die Prosa nicht trägt. SVG per Skill diagram-design erzeugen, Pfad hier eintragen, wird inline eingebettet",
    ),
    meta: obj(
      {
        createdAt: str("ISO-8601 Zeitstempel"),
        model: str(),
        branch: str(),
        repo: str(),
      },
      ["createdAt"],
      "Metadaten des Plans",
    ),
  },
  ["ticket", "slug", "title", "intent", "steps", "verification", "meta"],
  "Vollständiger Plan. Feldnamen englisch, Inhalte deutsch",
)

type RenderInput = { plan: unknown; outDir?: string; open?: boolean }

export type RenderToolOptions = {
  /** Öffnen-Kommando überschreiben, z. B. "firefox". Standard: Handler des Systems. */
  openWith?: string
  /** Projektverzeichnis; relative Pfade (outDir, svgPath) gelten ab hier. */
  directory: string
}

/**
 * Baut das Tool `plan_render`. Als Fabrik, damit das Plugin seine Optionen
 * (etwa ein abweichendes Öffnen-Kommando) und das Projektverzeichnis hineingeben kann.
 */
export function createPlanRenderTool(options: RenderToolOptions): Info {
  return {
    name: "plan_render",
    description:
      "Rendert einen Plan aus JSON zu einer eigenständigen HTML-Datei und öffnet sie im Standard-Browser. " +
      "Einziger Weg, einen Plan auszugeben: nie HTML oder Markdown selbst schreiben. " +
      "Nicht schemakonform → nichts geschrieben, Feldfehler kommen zurück, korrigieren und erneut aufrufen. " +
      "Felder und Schreibregeln: Skill \"planify\".",
    input: obj(
      {
        plan: planShape,
        outDir: str("Zielverzeichnis, Standard docs/plans im Projekt"),
        open: { type: "boolean", description: "HTML im Standard-Browser öffnen, Standard true" },
      },
      ["plan"],
    ),
    async execute(input) {
      const args = input as RenderInput
      const plan = args.plan as any
      const errors = validate(plan)
      if (errors.length) {
        return {
          content: [
            "Plan nicht geschrieben — Schema verletzt:",
            ...errors.map((f) => `  ${f.path || "/"}: ${f.message}`),
            "",
            "Felder korrigieren und plan_render erneut aufrufen.",
          ].join("\n"),
        }
      }

      const targetDir = resolve(options.directory, args.outDir ?? "docs/plans")
      mkdirSync(targetDir, { recursive: true })
      const name = baseName(plan)
      const jsonPath = resolve(targetDir, `${name}.plan.json`)
      const htmlPath = resolve(targetDir, `${name}.html`)

      let result
      try {
        result = render(plan, { baseDir: options.directory })
      } catch (renderError) {
        return { content: `Plan nicht geschrieben — Rendern fehlgeschlagen: ${(renderError as Error).message}` }
      }

      writeFileSync(jsonPath, JSON.stringify(plan, null, 2) + "\n", "utf8")
      writeFileSync(htmlPath, result.html, "utf8")

      const openCommand = args.open === false ? undefined : buildOpenCommand(htmlPath, options)
      if (openCommand) {
        spawn(openCommand.command, openCommand.args, { stdio: "ignore", detached: true }).unref()
      }

      const lines = [`Plan geschrieben:`, `  ${jsonPath}`, `  ${htmlPath}`]
      if (openCommand) lines.push(`Im Standard-Browser geöffnet (${openCommand.command}).`)
      else if (args.open !== false) lines.push("Kein Öffnen-Kommando für diese Plattform, Datei bitte selbst öffnen.")
      if (result.warnings.length) {
        lines.push("", "Warnungen zur Schreibweise (bitte im nächsten Zug korrigieren und neu rendern):")
        for (const w of result.warnings) lines.push(`  ${w.path}: ${w.message}`)
      }
      return {
        content: lines.join("\n"),
        metadata: { title: `${plan.ticket} — ${plan.title}`, jsonPath, htmlPath },
      }
    },
  }
}
