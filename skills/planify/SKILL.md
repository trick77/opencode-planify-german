---
name: planify
description: "Pläne als JSON bauen und über das Tool plan_render zu HTML rendern (Anthropic-Anmutung, optional mit Diagramm). Laden, bevor ein Plan, eine Spezifikation, ein Audit oder ein Umsetzungsvorschlag ausgegeben wird — enthält Schema, Feldbedeutungen, Schreibregeln und ein Beispiel."
compatibility: opencode
metadata:
  audience: alle Agents
  language: de-CH
---

# planify

Der Plan ist Inhalt, nicht Layout. Du lieferst ausschliesslich JSON, das Layout
kommt aus dem Nunjucks-Template. Ausgabeweg ist immer das Tool `plan_render`:
es validiert gegen `schema/plan.schema.json`, schreibt
`docs/plans/<TICKET>-<slug>.plan.json` und `<TICKET>-<slug>.html` und öffnet die
HTML-Datei in Safari.

Nie selbst HTML oder Markdown für einen Plan schreiben. Nie eine Plan-Datei mit
`write` oder `edit` anlegen. Kommen Schemafehler zurück, wurde nichts
geschrieben: Felder korrigieren, erneut aufrufen.

## Sprache

Feldnamen englisch, Inhalte deutsch. Echte Umlaute (ä, ö, ü), nie ae/oe/ue. Kein
Eszett, immer "ss" — ausgenommen zitierte Daten, Fixtures und Eigennamen. Der
Renderer warnt bei Verstössen; nach einer Warnung korrigieren und neu rendern.

Ausnahme `slug`: reines ASCII in Kebab-Case, weil er nur den Dateinamen bildet.

## Felder

| Feld | Pflicht | Inhalt |
| --- | --- | --- |
| `ticket` | ja | Ticket-Key aus dem Branch, Muster `[A-Z][A-Z0-9]+-[0-9]+`. Kein Treffer → beim Benutzer nachfragen, nicht raten. |
| `slug` | ja | Kurztitel in Kebab-Case, ASCII, maximal 60 Zeichen. |
| `title` | ja | Titel des Vorhabens, deutsch, ohne Ticket-Nummer. |
| `intent` | ja | Ein Absatz: was gemacht wird und warum. Keine Wiederholung des Titels. |
| `context` | nein | `problem` (was heute schiefgeht) und `outcome` (Zustand nach der Umsetzung). |
| `steps[]` | ja | Umsetzungsschritte in Reihenfolge: `title`, optional `rationale`, `files[]` mit exaktem `path` und `change`, optional `commands[]`. |
| `verification[]` | ja | `how` (auszuführendes Kommando oder Handgriff) und `expected` (woran man Erfolg erkennt). |
| `risks[]` | nein | `risk` und `mitigation`. Nur echte Risiken, keine Allgemeinplätze. |
| `openDecisions[]` | nein | `question`, `recommendation`, `tradeoff`. Jede offene Entscheidung gehört hierher. |
| `outOfScope[]` | nein | Was bewusst nicht gemacht wird. |
| `diagram` | nein | `title`, optional `caption`, `svgPath`. Siehe unten. |
| `meta` | ja | `createdAt` (ISO-8601), optional `model`, `branch`, `repo`. |

## Schreibregeln

- Kurze Sätze, Aussagen statt Absichtserklärungen. HTML ist kein Freibrief für
  Füllmaterial: kein Abschnitt "Ansatz", kein "Non-Goals"-Geraune, keine
  Wiederholung des Kontexts in jedem Schritt.
- `files[].path` ist ein exakter, existierender oder neu anzulegender Pfad
  relativ zum Projekt — nie "diverse Dateien", nie ein Verzeichnis als Sammelposten.
- `files[].change` sagt, was in dieser Datei passiert, in einem Satz.
- `rationale` nur, wenn die Begründung nicht offensichtlich ist.
- `verification` ist Ende zu Ende gedacht: Anwendung starten, Tests laufen
  lassen, Ausgabe prüfen. "Code kompiliert" ist keine Verifikation.
- Bestehende Funktionen und Hilfsmittel nennen, die wiederverwendet werden,
  jeweils mit Pfad.
- Ein Schritt, der etwas Bestehendes entfernt (Datei, Feature, UI-Element,
  Kommentar), sagt das ausdrücklich in `change`.

## Diagramm

Ein Diagramm nur, wenn es Struktur zeigt, die die Prosa nicht trägt:
Abhängigkeiten, Datenfluss, Zustände, Reihenfolgen mit Verzweigungen. Eine
lineare Schrittfolge wird aufgezählt, nicht gezeichnet.

Ablauf, wenn ein Diagramm sinnvoll ist:

1. Skill `diagram-design` laden und das Diagramm als HTML erzeugen.
2. Daraus ein `.svg` exportieren, nach dem Verfahren in
   `references/export.md` der Skill `diagram-design` (Abschnitt "SVG export
   procedure"): erstes `<svg>`-Element extrahieren, `xmlns` und `viewBox`
   sicherstellen, `title`/`desc` erhalten. Nur SVG, kein PNG — Playwright wird
   nicht gebraucht.
3. Pfad des SVG in `diagram.svgPath` eintragen, `title` und optional `caption`
   setzen.

planify liest das SVG, entfernt aktive Inhalte (`script`, `on*`) sowie den von
`diagram-design` injizierten Google-Fonts-Import und bettet es inline ein. Im
Diagramm greifen danach die Schriften des planify-Themes, was gewollt ist. Die HTML-Datei bleibt damit eigenständig und offline-fest: keine
Bilddatei daneben, keine CDN-Skripte, keine Web-Fonts, keine entfernten Bilder.
Ist `diagram-design` nicht verfügbar, `diagram` weglassen — kein handgeschriebenes
SVG, keine Mermaid-Blöcke im Plan.

## Beispiel

`references/beispiel-plan.json` ist ein vollständiger, schemakonformer Plan.
Lies ihn, wenn du unsicher bist, wie fein ein Schritt geschnitten sein soll.

Zum Ausprobieren ohne Modell, im planify-Repo:

```
npm run render -- skills/planify/references/beispiel-plan.json --out /tmp/planify-test
```
