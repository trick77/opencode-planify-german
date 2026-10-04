import { readFileSync, existsSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import Ajv from "ajv"
import addFormats from "ajv-formats"
import nunjucks from "nunjucks"

const here = dirname(fileURLToPath(import.meta.url))
export const root = resolve(here, "..")
export const schemaPath = resolve(root, "skills/planify/schema/plan.schema.json")
export const templateDir = resolve(root, "templates")

export type PlanError = { path: string; message: string }
export type PlanWarning = { path: string; message: string }

// Prosafelder: hier gilt die Schweizer Orthografie. Datenfelder (Pfade, Kommandos)
// bleiben unangetastet, dort darf ein Eszett aus einem Fixture stehen.
const NON_PROSE_KEYS = new Set(["path", "slug", "ticket", "createdAt", "svgPath"])

// Haeufige ASCII-Umschreibungen von Umlauten. Eine reine ue/oe/ae-Suche waere
// nutzlos, weil deutsche Woerter diese Folgen legitim enthalten (manuelle, neue).
const ASCII_TRANSCRIPTION = new RegExp(
  "\\b\\w*(?:" +
    [
      "fuer", "ueber", "uebrig", "uebernahm", "uebernehm", "uebersicht",
      "muess", "muesst", "koenn", "koennt", "moegl", "moecht",
      "aender", "aenderung", "groess", "hoeh", "laeng", "laess", "spaet",
      "naechst", "zurueck", "waehrend", "waehl", "gemaess", "haeuf", "haett",
      "duerf", "wuerd", "schliess", "ausfuehr", "durchfuehr", "einfueg",
      "pruef", "loesch", "loesung", "erklaer", "verfueg", "beruehr", "erhoeh",
      "kuenftig", "urspruengl", "vollstaendig", "abhaengig", "zusaetzl",
    ].join("|") +
    ")\\w*\\b",
  "gi",
)

let validator: ((data: unknown) => boolean) & { errors?: any[] } | undefined

function getValidator() {
  if (!validator) {
    const ajv = new Ajv({ allErrors: true, allowUnionTypes: true })
    addFormats(ajv)
    validator = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")))
  }
  return validator
}

/** Prüft den Plan gegen das Schema. Leeres Array bedeutet: valide. */
export function validate(plan: unknown): PlanError[] {
  const check = getValidator()
  if (check(plan)) return []
  return (check.errors ?? []).map((f) => ({
    path: f.instancePath || "/",
    message: `${f.message ?? "ungültig"}${f.params && Object.keys(f.params).length ? " (" + JSON.stringify(f.params) + ")" : ""}`,
  }))
}

/** Sucht Eszett und ASCII-Umschreibungen von Umlauten in Prosafeldern. */
export function checkSpelling(plan: unknown): PlanWarning[] {
  const warnings: PlanWarning[] = []
  const walk = (value: unknown, path: string, key?: string) => {
    if (typeof value === "string") {
      if (key && NON_PROSE_KEYS.has(key)) return
      if (value.includes("ß")) {
        warnings.push({ path, message: "Eszett gefunden, Schweizer Orthografie verlangt \"ss\"" })
      }
      const ascii = value.match(ASCII_TRANSCRIPTION)
      if (ascii) {
        warnings.push({
          path,
          message: `mögliche ASCII-Umschreibung eines Umlauts: ${[...new Set(ascii)].join(", ")} — echte Umlaute schreiben`,
        })
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach((entry, i) => walk(entry, `${path}/${i}`, key))
      return
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, `${path}/${k}`, k)
    }
  }
  walk(plan, "")
  return warnings
}

/** Liest das SVG und entfernt aktive Inhalte, damit die HTML-Datei offline und passiv bleibt. */
export function loadSvg(svgPath: string, baseDir: string): { svg: string; warnings: PlanWarning[] } {
  const absolutePath = isAbsolute(svgPath) ? svgPath : resolve(baseDir, svgPath)
  if (!existsSync(absolutePath)) {
    throw new Error(`SVG nicht gefunden: ${absolutePath}`)
  }
  let svg = readFileSync(absolutePath, "utf8")
  const warnings: PlanWarning[] = []
  const withoutXml = svg.replace(/<\?xml[^>]*\?>/g, "").replace(/<!DOCTYPE[^>]*>/gi, "")
  svg = withoutXml.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
  if (svg !== withoutXml) {
    warnings.push({ path: "/diagram/svgPath", message: "aktive Inhalte (script/on*) aus dem SVG entfernt" })
  }
  // diagram-design injiziert einen Google-Fonts-Import in exportierte SVG. Der Plan
  // muss offline-fest sein, also fliegt der Import raus; es greifen die Schriften des Themes.
  const withoutImport = svg.replace(/@import\s+url\([^)]*https?:[^)]*\)\s*;?/gi, "")
  if (withoutImport !== svg) {
    svg = withoutImport
    warnings.push({ path: "/diagram/svgPath", message: "entfernter Web-Font-Import aus dem SVG entfernt, damit die Datei offline-fest bleibt" })
  }
  if (/(?:href|src)\s*=\s*["']?https?:/i.test(svg) || /url\(["']?https?:/i.test(svg)) {
    warnings.push({ path: "/diagram/svgPath", message: "SVG verweist auf eine entfernte Ressource, die Datei ist dann nicht offline-fest" })
  }
  const start = svg.indexOf("<svg")
  if (start < 0) throw new Error(`Kein <svg>-Element in ${absolutePath}`)
  return { svg: svg.slice(start).trim(), warnings }
}

export function baseName(plan: any): string {
  return `${plan.ticket}-${plan.slug}`
}

export type RenderResult = { html: string; warnings: PlanWarning[] }

function assertValid(plan: unknown): void {
  const errors = validate(plan)
  if (errors.length) {
    throw new Error("Plan ist nicht schemakonform:\n" + errors.map((f) => `  ${f.path}: ${f.message}`).join("\n"))
  }
}

/**
 * Rendert den Plan zu eigenständigem HTML.
 * `baseDir` ist das Verzeichnis, gegen das ein relativer SVG-Pfad aufgelöst wird.
 */
export function render(plan: any, options: { baseDir?: string; template?: string } = {}): RenderResult {
  assertValid(plan)
  const warnings = checkSpelling(plan)
  const baseDir = options.baseDir ?? process.cwd()
  const template = options.template ?? "plan.njk"

  let svg: string | undefined
  if (plan.diagram?.svgPath) {
    const loaded = loadSvg(plan.diagram.svgPath, baseDir)
    svg = loaded.svg
    warnings.push(...loaded.warnings)
  }

  const env = nunjucks.configure(templateDir, { autoescape: true, trimBlocks: true, lstripBlocks: true })
  env.addFilter("date", formatDate)

  const css = readFileSync(resolve(templateDir, "theme.css"), "utf8")
  const html = env.render(template, { plan, css, svg, baseName: baseName(plan) })
  return { html, warnings }
}

function formatDate(value: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return new Intl.DateTimeFormat("de-CH", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Zurich" }).format(d)
}

function singleLine(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim()
}

// Inline-Code in Prosa bleibt unangetastet, escapt wird nur dazwischen.
const INLINE_CODE = /(`+[^`]*?`+)/

// Prosa für Markdown: eine Zeile, damit kein Umbruch eine Überschrift oder einen
// Listenpunkt zerreisst. Escapt wird nur, was Bitbucket als Backslash-Escape
// dokumentiert, und nur was sonst formatiert: "*", "_", "[", "]" und "\" selbst.
// "<" und "&" bleiben roh, Bitbucket escapt HTML selbst.
function escapeText(value: unknown): string {
  const escaped = singleLine(value)
    .split(INLINE_CODE)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/([\\*_[\]])/g, "\\$1")))
    .join("")
  // Blockmarker am Anfang: "# x", "+ x", "- x", "> x", "1. x", "1) x", Codezaun.
  return escaped
    .replace(/^([#+>-])/, "\\$1")
    .replace(/^(\d+)([.)])/, "$1\\$2")
    .replace(/^(`{3,}|~{3,})/, (fence) => fence.replace(/./g, "\\$&"))
}

// Code-Span mit mehr Backticks als im Inhalt, damit ein Backtick im Pfad oder
// Kommando den Span nicht vorzeitig schliesst.
function codeSpan(value: unknown): string {
  const text = singleLine(value)
  const fence = "`".repeat(longestBacktickRun(text) + 1)
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : ""
  return `${fence}${pad}${text}${pad}${fence}`
}

// Bitbucket dokumentiert nur ```-Blöcke. Enthält ein Kommando selbst ```, wird
// eingerückt (vier Leerzeichen), das ist die zweite dokumentierte Form. Die Zeile
// "Kommandos:" davor beendet die Dateiliste; direkt nach einem Listenpunkt wäre
// der eingerückte Block sonst ein Absatz in diesem Punkt. Leerzeilen im Block
// tragen den Einzug, damit collapseBlankLines sie nicht zusammenzieht.
function codeBlock(lines: string[]): string {
  const text = lines.join("\n")
  if (!text.includes("```")) return "```sh\n" + text + "\n```"
  return "Kommandos:\n\n" + text.split("\n").map((line) => `    ${line}`).join("\n")
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
}

// Mehrfache Leerzeilen aus dem Template zusammenziehen, aber nicht in Codeblöcken:
// dort gehören Leerzeilen zum Kommando.
function collapseBlankLines(markdown: string): string {
  const out: string[] = []
  let inFence = false
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) inFence = !inFence
    else if (!inFence && line === "" && out.length && out[out.length - 1] === "") continue
    out.push(line)
  }
  return out.join("\n").trim() + "\n"
}

// Zeilenbreite wie in noergler (backend/internal/render/wrap.go): Bitbucket zeigt
// einen Absatz sonst über die ganze Fensterbreite. Ein einzelner Zeilenumbruch im
// Absatz ist in Bitbucket Data Center ein sichtbarer Umbruch.
export const WRAP_WIDTH = 110
// Listenpunkte enger, Marker und hängender Einzug machen sie sonst breiter als Prosa.
export const LIST_WRAP_WIDTH = 90

const NEVER_WRAP = /^\s*(?:#{1,6}\s|>|---\s*$)/
const LIST_ITEM = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/
// Ein Wort: Folge aus Code-Spans und Nicht-Leerzeichen, ein Code-Span mit
// Leerzeichen wird so nie getrennt.
const WORD = /(?:(`+)[\s\S]*?\1|\S)+/g
// Am Zeilenanfang würde so ein Wort zu Liste, Überschrift, Zitat, Trennlinie
// oder Codeblock. Es bleibt deshalb an der Vorzeile hängen.
const BLOCK_START = /^(?:#{1,6}|[>+*-]|\d+[.)]|-{3,}|=+|```.*)$/

function wrapLine(content: string, width: number, prefix: string): string {
  const words = content.match(WORD) ?? []
  if (words.length === 0) return prefix + content
  const indent = " ".repeat(prefix.length)
  const lines: string[] = []
  let current = prefix + words[0]
  for (const word of words.slice(1)) {
    if (current.length + 1 + word.length <= width || BLOCK_START.test(word)) {
      current += " " + word
    } else {
      lines.push(current)
      current = indent + word
    }
  }
  lines.push(current)
  return lines.join("\n")
}

/**
 * Bricht Prosa bei WRAP_WIDTH um, Listenpunkte bei LIST_WRAP_WIDTH mit hängendem
 * Einzug. Überschriften, Zitate, Trennlinien und Codeblöcke bleiben unverändert;
 * Code-Spans und lange Wörter (Pfade, URLs) werden nie getrennt, die Breite ist
 * ein Ziel, keine Garantie.
 */
export function wrapProse(markdown: string, width = WRAP_WIDTH, listWidth = LIST_WRAP_WIDTH): string {
  const out: string[] = []
  let inFence = false
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence || line.trim() === "" || line.startsWith("    ") || NEVER_WRAP.test(line)) {
      out.push(line)
      continue
    }
    const item = line.match(LIST_ITEM)
    if (item) {
      out.push(wrapLine(item[2], listWidth, item[1]))
      continue
    }
    const lead = line.match(/^\s*/)![0]
    out.push(wrapLine(line.slice(lead.length), width, lead))
  }
  return out.join("\n")
}

let markdownEnv: nunjucks.Environment | undefined

// Eigene Umgebung statt nunjucks.configure: die setzt die globale Standard-Umgebung,
// und Markdown braucht autoescape aus, HTML an. Einmal gebaut, Templates gecacht.
function getMarkdownEnv(): nunjucks.Environment {
  if (!markdownEnv) {
    markdownEnv = new nunjucks.Environment(new nunjucks.FileSystemLoader(templateDir), {
      autoescape: false,
      trimBlocks: true,
      lstripBlocks: true,
    })
    markdownEnv.addFilter("date", formatDate)
    markdownEnv.addFilter("text", escapeText)
    markdownEnv.addFilter("code", codeSpan)
    markdownEnv.addFilter("codeblock", codeBlock)
  }
  return markdownEnv
}

export type MarkdownResult = { markdown: string; warnings: PlanWarning[] }

/**
 * Rendert den Plan als Markdown für die Description eines Bitbucket-Data-Center-PRs.
 * Ein Diagramm fehlt dort: Bitbucket stellt kein SVG dar, die Description verweist
 * auf den HTML-Plan.
 */
export function renderMarkdown(plan: any): MarkdownResult {
  assertValid(plan)
  const warnings = checkSpelling(plan)
  if (plan.diagram) {
    warnings.push({ path: "/diagram", message: "Diagramm nicht in der PR-Description, Bitbucket stellt kein SVG dar" })
  }
  const markdown = getMarkdownEnv().render("plan.md.njk", { plan, baseName: baseName(plan) })
  return { markdown: wrapProse(collapseBlankLines(markdown)), warnings }
}
