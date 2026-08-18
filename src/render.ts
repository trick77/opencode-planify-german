import { readFileSync, existsSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import Ajv from "ajv"
import addFormats from "ajv-formats"
import nunjucks from "nunjucks"

const hier = dirname(fileURLToPath(import.meta.url))
export const wurzel = resolve(hier, "..")
export const schemaPfad = resolve(wurzel, "skills/planify/schema/plan.schema.json")
export const templateVerzeichnis = resolve(wurzel, "templates")

export type Fehler = { pfad: string; meldung: string }
export type Warnung = { pfad: string; meldung: string }

// Prosafelder: hier gilt die Schweizer Orthografie. Datenfelder (Pfade, Kommandos)
// bleiben unangetastet, dort darf ein Eszett aus einem Fixture stehen.
const KEINE_PROSA = new Set(["path", "slug", "ticket", "createdAt", "svgPath"])

// Haeufige ASCII-Umschreibungen von Umlauten. Eine reine ue/oe/ae-Suche waere
// nutzlos, weil deutsche Woerter diese Folgen legitim enthalten (manuelle, neue).
const ASCII_UMSCHRIFT = new RegExp(
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

let validator: ((daten: unknown) => boolean) & { errors?: any[] } | undefined

function holeValidator() {
  if (!validator) {
    const ajv = new Ajv({ allErrors: true, allowUnionTypes: true })
    addFormats(ajv)
    validator = ajv.compile(JSON.parse(readFileSync(schemaPfad, "utf8")))
  }
  return validator
}

/** Prüft den Plan gegen das Schema. Leeres Array bedeutet: valide. */
export function validiere(plan: unknown): Fehler[] {
  const pruefen = holeValidator()
  if (pruefen(plan)) return []
  return (pruefen.errors ?? []).map((f) => ({
    pfad: f.instancePath || "/",
    meldung: `${f.message ?? "ungültig"}${f.params && Object.keys(f.params).length ? " (" + JSON.stringify(f.params) + ")" : ""}`,
  }))
}

/** Sucht Eszett und ASCII-Umschreibungen von Umlauten in Prosafeldern. */
export function pruefeSchreibweise(plan: unknown): Warnung[] {
  const warnungen: Warnung[] = []
  const gehe = (wert: unknown, pfad: string, schluessel?: string) => {
    if (typeof wert === "string") {
      if (schluessel && KEINE_PROSA.has(schluessel)) return
      if (wert.includes("ß")) {
        warnungen.push({ pfad, meldung: "Eszett gefunden, Schweizer Orthografie verlangt \"ss\"" })
      }
      const ascii = wert.match(ASCII_UMSCHRIFT)
      if (ascii) {
        warnungen.push({
          pfad,
          meldung: `mögliche ASCII-Umschreibung eines Umlauts: ${[...new Set(ascii)].join(", ")} — echte Umlaute schreiben`,
        })
      }
      return
    }
    if (Array.isArray(wert)) {
      wert.forEach((eintrag, i) => gehe(eintrag, `${pfad}/${i}`, schluessel))
      return
    }
    if (wert && typeof wert === "object") {
      for (const [k, v] of Object.entries(wert as Record<string, unknown>)) gehe(v, `${pfad}/${k}`, k)
    }
  }
  gehe(plan, "")
  return warnungen
}

/** Liest das SVG und entfernt aktive Inhalte, damit die HTML-Datei offline und passiv bleibt. */
export function ladeSvg(svgPfad: string, basis: string): { svg: string; warnungen: Warnung[] } {
  const absolut = isAbsolute(svgPfad) ? svgPfad : resolve(basis, svgPfad)
  if (!existsSync(absolut)) {
    throw new Error(`SVG nicht gefunden: ${absolut}`)
  }
  let svg = readFileSync(absolut, "utf8")
  const warnungen: Warnung[] = []
  const ohneXml = svg.replace(/<\?xml[^>]*\?>/g, "").replace(/<!DOCTYPE[^>]*>/gi, "")
  svg = ohneXml.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
  if (svg !== ohneXml) {
    warnungen.push({ pfad: "/diagram/svgPath", meldung: "aktive Inhalte (script/on*) aus dem SVG entfernt" })
  }
  // diagram-design injiziert einen Google-Fonts-Import in exportierte SVG. Der Plan
  // muss offline-fest sein, also fliegt der Import raus; es greifen die Schriften des Themes.
  const ohneImport = svg.replace(/@import\s+url\([^)]*https?:[^)]*\)\s*;?/gi, "")
  if (ohneImport !== svg) {
    svg = ohneImport
    warnungen.push({ pfad: "/diagram/svgPath", meldung: "entfernter Web-Font-Import aus dem SVG entfernt, damit die Datei offline-fest bleibt" })
  }
  if (/(?:href|src)\s*=\s*["']?https?:/i.test(svg) || /url\(["']?https?:/i.test(svg)) {
    warnungen.push({ pfad: "/diagram/svgPath", meldung: "SVG verweist auf eine entfernte Ressource, die Datei ist dann nicht offline-fest" })
  }
  const start = svg.indexOf("<svg")
  if (start < 0) throw new Error(`Kein <svg>-Element in ${absolut}`)
  return { svg: svg.slice(start).trim(), warnungen }
}

export function dateiname(plan: any): string {
  return `${plan.ticket}-${plan.slug}`
}

export type RenderErgebnis = { html: string; warnungen: Warnung[] }

/**
 * Rendert den Plan zu eigenständigem HTML.
 * `basis` ist das Verzeichnis, gegen das ein relativer SVG-Pfad aufgelöst wird.
 */
export function rendere(plan: any, optionen: { basis?: string; template?: string } = {}): RenderErgebnis {
  const fehler = validiere(plan)
  if (fehler.length) {
    throw new Error("Plan ist nicht schemakonform:\n" + fehler.map((f) => `  ${f.pfad}: ${f.meldung}`).join("\n"))
  }
  const warnungen = pruefeSchreibweise(plan)
  const basis = optionen.basis ?? process.cwd()
  const template = optionen.template ?? "plan.njk"

  let svg: string | undefined
  if (plan.diagram?.svgPath) {
    const geladen = ladeSvg(plan.diagram.svgPath, basis)
    svg = geladen.svg
    warnungen.push(...geladen.warnungen)
  }

  const umgebung = nunjucks.configure(templateVerzeichnis, { autoescape: true, trimBlocks: true, lstripBlocks: true })
  umgebung.addFilter("datum", (wert: string) => {
    const d = new Date(wert)
    if (Number.isNaN(d.getTime())) return wert
    return new Intl.DateTimeFormat("de-CH", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Zurich" }).format(d)
  })

  const css = readFileSync(resolve(templateVerzeichnis, "theme.css"), "utf8")
  const html = umgebung.render(template, { plan, css, svg, basisname: dateiname(plan) })
  return { html, warnungen }
}
