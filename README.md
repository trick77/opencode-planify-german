# opencode-planify-german

Pläne für OpenCode: das Modell liefert JSON, ein lokales Nunjucks-Template
rendert daraus eine eigenständige HTML-Datei und öffnet sie im Standard-Browser
des Systems. Pläne sind deutsch, in Schweizer Rechtschreibung mit echten
Umlauten. Läuft lokal in OpenCode, als Plugin plus Skill.

Das Layout ist festverdrahtet, das Modell liefert nur Inhalt: deshalb sieht jeder
Plan gleich aus, und das JSON daneben bleibt maschinenlesbar.

## Warum

**Günstiger pro Plan.** Das Modell erzeugt nur die Aussagen, die Form kommt aus
dem Template auf deiner Platte. Die Tokens gehen in den Inhalt, nicht in Tags,
die sich von Plan zu Plan ohnehin nie ändern.

**Verlässliche Struktur.** Der Plan wird gegen ein Schema geprüft, bevor etwas
geschrieben wird: fehlt die Verifikation oder ein Dateipfad, kommt der Plan mit
Feldfehlern zurück und das Modell zieht nach.

**Schneller zu prüfen.** Schritte stehen als nummerierte Karten, Pfad und
Änderung nebeneinander, offene Entscheidungen mit Empfehlung und Abwägung
hervorgehoben. Du siehst in Sekunden, welche Dateien angefasst werden und woran
Erfolg gemessen wird.

**Kontext im Pull Request.** Der Plan liegt als HTML und als JSON in
`docs/plans/` und geht mit dem Code ins Review. Der Kollege sieht Problem,
Schritte und Verifikation, statt die Absicht aus dem Diff zu erschliessen — bei
agentengeschriebenem Code die erste Frage.

**Deutsch liest sich schneller und genauer.** In der Muttersprache läuft das
Lesen automatisch ab, die Aufmerksamkeit bleibt für die inhaltlichen Fragen frei:
trifft der Schritt das Problem, stimmt die Reihenfolge, geht eine Zusage zu weit.
Der Unterschied zwischen "muss", "soll" und "kann" fällt beim ersten Lesen auf —
und ein zweites Lesen findet unter Zeitdruck selten statt.

## Bestandteile

| Teil | Datei | Wirkung |
| --- | --- | --- |
| Instructions | `instructions/planify.md` | Immer geladen: Deutsch, Schweizer Rechtschreibung, Plan als JSON über `plan_render`. |
| Skill | `skills/planify/SKILL.md` | Auf Abruf: Schema, Feldbedeutungen, Schreibregeln, Diagrammweg, Beispiel. |
| Plugin | `src/plugin.ts` | Registriert das Tool `plan_render`: validiert, schreibt JSON und HTML nach `docs/plans/`, öffnet die Datei. |
| Renderer | `src/render.ts`, `templates/` | Schema-Prüfung (ajv), Orthografie-Warnungen, Nunjucks, SVG inline. |

## Installation

Über [opencode-presets](https://github.com/trick77/opencode-presets):

```sh
npx opencode-presets install opencode-planify-german
```

Das Bundle installiert die drei Teile zusammen: das Plugin mit dem Tool
`plan_render` (gepinnt), die Regeldatei nach `instructions` und den Skill nach
`skills.paths`.

Prüfen:

```sh
opencode debug agent plan | grep plan_render
opencode debug skill | grep planify
```

Deinstallieren:

```sh
npx opencode-presets remove opencode-planify-german
```

## Ablauf

1. Die Regeldatei ist in jeder Session geladen und verlangt den Plan als JSON.
2. Das Ticket kommt aus dem Branch (`git rev-parse --abbrev-ref HEAD`, Muster
   `[A-Z][A-Z0-9]+-[0-9]+`). Kein Treffer → das Modell fragt nach.
3. Das JSON geht an `plan_render`. Bei Schemaverletzungen kommen die Feldfehler
   zurück, bevor etwas geschrieben wird; das Modell korrigiert selbst.
4. Eszett und ASCII-Umschreibungen von Umlauten in Prosafeldern kommen als
   Warnung zurück. Pfade, Kommandos und der Slug sind ausgenommen.
5. Geschrieben werden `docs/plans/<TICKET>-<slug>.plan.json` und `.html`, dann
   öffnet die Datei.

## Browser

Geöffnet wird mit dem Standard-Handler des Systems: `open` auf macOS,
`xdg-open` auf Linux, `start` auf Windows. Überschreiben geht über die
Plugin-Option `openWith` oder die Umgebungsvariable `PLANIFY_OPEN`. `plan_render`
mit `open: false` schreibt die Dateien, ohne etwas zu öffnen.

## Diagramme

Optional, für Struktur, die die Prosa nicht trägt: Abhängigkeiten, Datenfluss,
Zustände, Reihenfolgen mit Verzweigungen.

Erzeugt wird das Diagramm mit dem Skill `diagram-design`, als SVG exportiert, der
Pfad steht im Plan unter `diagram.svgPath`. planify bettet das SVG inline ein und
entfernt dabei `script`, `on*`-Attribute und den Google-Fonts-Import, damit die
Plan-Datei offline-fest bleibt.

Auch der Skill kommt über ein Preset. Er liegt in einem fremden Repo ohne Tags,
deshalb klonst du selbst und gibst den Pfad mit:

```sh
git clone https://github.com/cathrynlavery/diagram-design.git
npx opencode-presets install skill-diagram-design --set skillsDir="$PWD/diagram-design/skills"
```
