import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { dateiname, ladeSvg, pruefeSchreibweise, rendere, validiere, wurzel } from "../src/render.ts"

const beispielPfad = resolve(wurzel, "skills/planify/references/beispiel-plan.json")
const beispiel = () => JSON.parse(readFileSync(beispielPfad, "utf8"))

test("valider Plan rendert eigenständiges HTML", () => {
  // Given
  const plan = beispiel()

  // When
  const { html, warnungen } = rendere(plan, { basis: wurzel })

  // Then
  assert.equal(warnungen.length, 0)
  assert.ok(html.startsWith("<!doctype html>"))
  assert.match(html, /<meta charset="utf-8">/)
  assert.match(html, /<html lang="de">/)
  assert.match(html, new RegExp(plan.title))
  assert.match(html, /MapStruct als annotationProcessor/)
  assert.doesNotMatch(html, /https?:\/\//)
  assert.doesNotMatch(html, /<img/)
})

test("Umlaute bleiben echte Zeichen und Eszett kommt nicht vor", () => {
  // When
  const { html } = rendere(beispiel(), { basis: wurzel })

  // Then
  assert.ok(html.includes("Änderung") || html.includes("löschen"))
  assert.doesNotMatch(html, /ß/)
  assert.doesNotMatch(html, /&auml;|&uuml;|&ouml;/)
})

test("unvollständiger Plan liefert Feldfehler statt HTML", () => {
  // Given
  const plan = beispiel()
  delete plan.verification

  // When
  const fehler = validiere(plan)

  // Then
  assert.ok(fehler.length > 0)
  assert.ok(fehler.some((f) => f.meldung.includes("verification")))
  assert.throws(() => rendere(plan, { basis: wurzel }), /nicht schemakonform/)
})

test("Ticket ohne Muster wird abgelehnt", () => {
  // Given
  const plan = beispiel()
  plan.ticket = "kein-ticket"

  // When
  const fehler = validiere(plan)

  // Then
  assert.ok(fehler.some((f) => f.pfad === "/ticket"))
})

test("Eszett und ASCII-Umschreibung werden als Warnung gemeldet", () => {
  // Given
  const plan = beispiel()
  plan.intent = "Die Groesse der Aenderung heißt, dass wir fuer den Build eine neue, manuelle Lösung brauchen."

  // When
  const warnungen = pruefeSchreibweise(plan)

  // Then
  assert.ok(warnungen.some((w) => w.meldung.includes("Eszett")))
  const ascii = warnungen.find((w) => w.meldung.includes("ASCII-Umschreibung"))
  assert.ok(ascii)
  assert.match(ascii.meldung, /Groesse/)
  assert.match(ascii.meldung, /fuer/)
  assert.doesNotMatch(ascii.meldung, /manuelle|neue/)
})

test("Pfade und Kommandos werden nicht auf Orthografie geprüft", () => {
  // Given
  const plan = beispiel()
  plan.steps[0].files[0].path = "src/Strassenverzeichnis-groß.java"

  // When
  const warnungen = pruefeSchreibweise(plan)

  // Then
  assert.equal(warnungen.length, 0)
})

test("SVG wird inline eingebettet, aktive Inhalte fliegen raus", () => {
  // Given
  const verzeichnis = mkdtempSync(resolve(tmpdir(), "planify-"))
  const svgPfad = resolve(verzeichnis, "abhaengigkeiten.svg")
  writeFileSync(
    svgPfad,
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect onclick="alert(2)" width="10" height="10"/></svg>',
    "utf8",
  )
  const plan = beispiel()
  plan.diagram = { title: "Abhängigkeiten", caption: "Beispiel", svgPath: "abhaengigkeiten.svg" }

  // When
  const { html, warnungen } = rendere(plan, { basis: verzeichnis })
  const geladen = ladeSvg(svgPfad, verzeichnis)

  // Then
  assert.match(html, /<svg /)
  assert.doesNotMatch(html, /<script>alert/)
  assert.doesNotMatch(html, /onclick/)
  assert.match(html, /Abhängigkeiten/)
  assert.ok(geladen.svg.startsWith("<svg"))
  assert.ok(warnungen.some((w) => w.meldung.includes("aktive Inhalte")))
})

test("fehlendes SVG bricht mit klarer Meldung ab", () => {
  // Given
  const plan = beispiel()
  plan.diagram = { title: "Fehlt", svgPath: "gibt-es-nicht.svg" }

  // When / Then
  assert.throws(() => rendere(plan, { basis: wurzel }), /SVG nicht gefunden/)
})

test("Dateiname setzt sich aus Ticket und Slug zusammen", () => {
  // When / Then
  assert.equal(dateiname(beispiel()), "SEP-24758-mapstruct-gradle-migration")
})

test("Nunjucks escapt Inhalte aus dem Plan", () => {
  // Given
  const plan = beispiel()
  plan.steps[0].title = "<script>alert('x')</script>"

  // When
  const { html } = rendere(plan, { basis: wurzel })

  // Then
  assert.doesNotMatch(html, /<script>alert/)
  assert.match(html, /&lt;script&gt;/)
})

test("Web-Font-Import aus einem diagram-design-Export wird entfernt", () => {
  // Given
  const verzeichnis = mkdtempSync(resolve(tmpdir(), "planify-"))
  const svgPfad = resolve(verzeichnis, "architektur.svg")
  writeFileSync(
    svgPfad,
    '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      "<defs><style>@import url('https://fonts.googleapis.com/css2?family=Geist&amp;display=swap');</style></defs>" +
      '<rect width="10" height="10"/></svg>',
    "utf8",
  )
  const plan = beispiel()
  plan.diagram = { title: "Architektur", svgPath: "architektur.svg" }

  // When
  const { html, warnungen } = rendere(plan, { basis: verzeichnis })

  // Then
  assert.doesNotMatch(html, /fonts\.googleapis\.com/)
  // xmlns bleibt erlaubt, es ist eine Namensraum-URI und kein Abruf
  assert.doesNotMatch(html, /(?:href|src)\s*=\s*["']https?:/)
  assert.doesNotMatch(html, /url\(["']?https?:/)
  assert.ok(warnungen.some((w) => w.meldung.includes("Web-Font-Import")))
})
