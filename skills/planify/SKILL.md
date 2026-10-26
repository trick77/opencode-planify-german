---
name: planify
description: "Pläne als JSON bauen und über das Tool plan_render zu HTML rendern, mit Diagramm, sobald Entitäten, Abläufe, Zustände oder Architektur berührt sind. Laden, bevor ein Plan, eine Spezifikation, ein Audit oder ein Umsetzungsvorschlag ausgegeben wird — enthält Schema, Feldbedeutungen, Schreibregeln und ein Beispiel."
compatibility: opencode
metadata:
  audience: alle Agents
  language: de-CH
---

# planify

Der Plan ist Inhalt, nicht Layout. Du lieferst JSON, das Layout kommt aus dem
Nunjucks-Template. Ausgabeweg ist immer das Tool `plan_render`: es validiert
gegen `schema/plan.schema.json`, schreibt
`docs/plans/<TICKET>-<slug>.plan.json` plus `<TICKET>-<slug>.html` und öffnet die
HTML-Datei im Standard-Browser.

Nie selbst HTML oder Markdown für einen Plan schreiben, nie eine Plan-Datei per
`write` oder `edit` anlegen. Schemafehler zurück → nichts geschrieben, Felder
korrigieren, erneut aufrufen.

## Tool fehlt

Ist `plan_render` in dieser Sitzung nicht verfügbar, ist das Plugin nicht
installiert. Dann keinen Plan schreiben — weder als HTML noch als Markdown noch
als Fliesstext im Chat — sondern abbrechen und im Chat genau das melden:

```sh
npx opencode-presets install opencode-planify-german
```

Danach opencode neu starten (`opencode service restart`): Plugins werden beim
Start aufgelöst, ein laufender Prozess sieht die Installation nicht. Braucht
opencode 2 oder neuer. Prüfen mit:

```sh
opencode plugin list | grep opencode-planify-german
```

Die Liste füllt sich erst einige Sekunden nach dem Neustart. Bleibt der Treffer aus, ist die Installation das Problem und nicht der Plan. Erst
weitermachen, wenn das Tool da ist.

## Sprache

Feldnamen englisch, Inhalte deutsch. Echte Umlaute (ä, ö, ü), nie ae/oe/ue. Kein
Eszett, immer "ss" — ausgenommen zitierte Daten, Fixtures, Eigennamen. Der
Renderer warnt bei Verstössen: korrigieren, neu rendern.

`slug` ist die Ausnahme: reines ASCII in Kebab-Case, er bildet nur den Dateinamen.

## Felder

| Feld | Pflicht | Inhalt |
| --- | --- | --- |
| `ticket` | ja | Ticket-Key aus dem Branch, Muster `[A-Z][A-Z0-9]+-[0-9]+`. Kein Treffer → nachfragen, nicht raten. |
| `slug` | ja | Kurztitel in Kebab-Case, ASCII, maximal 60 Zeichen. |
| `title` | ja | Titel des Vorhabens, deutsch, ohne Ticket-Nummer. |
| `intent` | ja | Ein Absatz: was gemacht wird und warum. Keine Wiederholung des Titels. |
| `context` | nein | `problem` (was heute schiefgeht), `outcome` (Zustand nach der Umsetzung). |
| `steps[]` | ja | Schritte in Reihenfolge: `title`, optional `rationale`, `files[]` mit exaktem `path` und `change`, optional `commands[]`. |
| `verification[]` | ja | `how` (Kommando oder Handgriff), `expected` (woran man Erfolg erkennt). |
| `risks[]` | nein | `risk`, `mitigation`. Nur echte Risiken, keine Allgemeinplätze. |
| `openDecisions[]` | nein | `question`, `recommendation`, `tradeoff`. Jede offene Entscheidung gehört hierher. |
| `outOfScope[]` | nein | Was bewusst nicht gemacht wird. |
| `diagram` | nein | `title`, optional `caption`, `svgPath`. Siehe unten. |
| `meta` | ja | `createdAt` (ISO-8601), optional `model`, `branch`, `repo`. |

## Schreibregeln

- Kurze Sätze, Aussagen statt Absichtserklärungen. HTML ist kein Freibrief für
  Füllmaterial: kein Abschnitt "Ansatz", kein "Non-Goals", keine Wiederholung des
  Kontexts in jedem Schritt.
- `files[].path`: exakter Pfad relativ zum Projekt, bestehend oder neu anzulegen.
  Nie "diverse Dateien", nie ein Verzeichnis als Sammelposten.
- `files[].change`: was in dieser Datei passiert, ein Satz.
- `rationale` nur, wenn die Begründung nicht offensichtlich ist.
- `verification` Ende zu Ende: Anwendung starten, Tests laufen lassen, Ausgabe
  prüfen. "Code kompiliert" ist keine Verifikation.
- Wiederverwendete Funktionen und Hilfsmittel nennen, mit Pfad.
- Entfernt ein Schritt etwas Bestehendes (Datei, Feature, UI-Element, Kommentar),
  sagt `change` das ausdrücklich.

## Diagramm

Im Zweifel zeichnen. Ein Diagramm gehört in den Plan, sobald der Plan eines
davon berührt (Typ von `diagram-design` in Klammern):

| Der Plan berührt … | Typ |
| --- | --- |
| Entitäten, Tabellen, Beziehungen, ein Datenmodell | `er`, `db-schema`, `uml-class` |
| Daten, die durch Komponenten oder Systeme fliessen | `data-flow`, `dp-integration` |
| Ablauf mit Verzweigungen, Fehlerpfaden, Entscheidungen | `flowchart`, `swimlane` |
| Aufrufe zwischen Diensten, Requests, Events, Nachrichten | `sequence` |
| Status und Übergänge (Bestellung, Ticket, Workflow) | `state` |
| Komponenten, Module, Schichten und wie sie zusammenhängen | `architecture`, `layers`, `dependency` |
| Umbau einer Architektur, vorher und nachher | `architecture-delta` |
| Wo was läuft: Container, Umgebungen, Netz | `deployment` |

Kein Diagramm nur bei einer rein linearen Schrittfolge ohne Komponenten,
Entitäten oder Verzweigungen, etwa eine Dependency hochziehen. Die steht schon
in `steps[]`. Ein Diagramm pro Plan: das, was beim Review am meisten Lesezeit
spart.

1. Skill `diagram-design` laden, Diagramm als HTML erzeugen. Dessen Stil-Frage
   beim ersten Diagramm (Onboarding-Gate: "Customize now?") nicht stellen, sondern
   den Default behalten (Option e), auch ohne `.diagram-design`-Marker im
   Projekt. Kein Profil speichern. Der Plan soll nicht auf eine Stilfrage warten.
2. Daraus `.svg` exportieren, mit dem Helfer aus dem Skill-Verzeichnis von
   `diagram-design`: `python3 scripts/export_svg.py <html> <out.svg> --system-fonts`.
   Ohne `python3` von Hand nach `references/export.md`, Abschnitt "SVG export
   procedure". Nur SVG, kein PNG — Playwright wird nicht gebraucht.
3. Pfad in `diagram.svgPath`, dazu `title` und optional `caption`.

planify entfernt aktive Inhalte (`script`, `on*`) und den von `diagram-design`
injizierten Google-Fonts-Import und bettet das SVG inline ein; im Diagramm
greifen dann die Schriften des Themes. So bleibt die HTML-Datei eigenständig:
keine Bilddatei daneben, keine CDN-Skripte, keine Web-Fonts, keine entfernten
Bilder.

Wäre ein Diagramm angebracht und `diagram-design` ist nicht verfügbar: `diagram`
weglassen und im Chat genau einen Satz schreiben: "Diagramm weggelassen: Skill
`diagram-design` fehlt (`npx opencode-presets install skill-diagram-design`)."
Nie still weglassen, sonst sieht ein fehlender Skill aus wie ein bewusster
Verzicht. Kein handgeschriebenes SVG, keine Mermaid-Blöcke im Plan.

## PR-Description

`pr_summary` schreibt eine Zusammenfassung in die Description eines
Bitbucket-Data-Center-PRs. Hat der Branch noch keinen offenen PR, legt es ihn als
Draft an, mit der Zusammenfassung als Description. Ist die Umsetzung fertig und
der Branch gepusht, bietet das Modell es einmal an; geschrieben wird erst nach Ja.

| Argument | Pflicht | Inhalt |
| --- | --- | --- |
| `summary` | ja | 1-3 Absätze Prosa, getrennt durch eine Leerzeile: Aufgabe, Problem oder Herausforderung, Lösung. |
| `prUrl` | nein | PR-URL aus dem Browser. Nur bei mehreren offenen PRs oder einem PR ausserhalb des aktuellen Branches. |
| `title` | zum Anlegen | Titel des neuen PRs. Bei bestehendem PR ignoriert. |
| `targetBranch` | zum Anlegen | Ziel-Branch, vom Benutzer bestätigt. Nie raten. |

Anlegen in zwei Schritten: erst ohne `title`/`targetBranch` aufrufen, das Tool
liefert einen Ziel-Vorschlag (Basis des Branches, nie master/main) oder keinen.
Benutzer fragen, ob der Vorschlag gilt bzw. welches Ziel, dann mit `title` und
`targetBranch` erneut aufrufen. Default-Reviewer setzt das Tool selbst. Aus
master/main oder einem ungepushten Branch legt es nichts an.

Mehr als 3 Absätze oder eine leere Zusammenfassung lehnt das Tool ab, ohne Bitbucket
anzufassen. Escapt und bei 110 Zeichen umbrochen wird im Tool. Bei bestehendem PR
wird die Description vollständig ersetzt, Titel und Reviewer bleiben. Nie ein
Kommentar.

Description veraltet — seit der letzten Zusammenfassung ist wesentliche Arbeit
dazugekommen (neuer Teil der Lösung, geänderter Ansatz, nicht nur Fixes oder
Review-Kleinkram): einmal anbieten, sie zu aktualisieren, erst nach Ja.

## Beispiel

`references/beispiel-plan.json` ist ein vollständiger, schemakonformer Plan. Lies
ihn, wenn unklar ist, wie fein ein Schritt geschnitten sein soll.
