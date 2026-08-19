# opencode-planify-german

Pläne für OpenCode: das Modell liefert JSON, ein lokales Nunjucks-Template
rendert daraus eine eigenständige HTML-Datei und öffnet sie im Standard-Browser
des Systems. Pläne sind deutsch, mit echten Umlauten und ohne Eszett. Kein
MCP-Server. Nur OpenCode.

Das Layout ist festverdrahtet, das Modell liefert nur Inhalt: deshalb sieht jeder
Plan gleich aus, und das JSON daneben bleibt maschinenlesbar.

## Bestandteile

| Teil | Datei | Wirkung |
| --- | --- | --- |
| Instructions | `instructions/planify.md` | Immer geladen: Deutsch, echte Umlaute, kein Eszett, Plan nur als JSON über `plan_render`. |
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
`skills.paths`. Einzeln bringt keiner davon etwas — die Regeln nennen sonst ein
Tool, das es nicht gibt, und das Plugin wird nie aufgerufen.

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

1. Die Regeldatei ist in jeder Session geladen und verlangt: Plan als JSON, kein
   handgeschriebenes HTML oder Markdown.
2. Das Ticket kommt aus dem Branch (`git rev-parse --abbrev-ref HEAD`, Muster
   `[A-Z][A-Z0-9]+-[0-9]+`). Kein Treffer → das Modell fragt nach.
3. Das JSON geht an `plan_render`. Verletzt es das Schema, wird nichts
   geschrieben und die Feldfehler kommen zurück; das Modell korrigiert selbst.
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

Optional und nur, wenn ein Diagramm Struktur zeigt, die die Prosa nicht trägt:
Abhängigkeiten, Datenfluss, Zustände, Reihenfolgen mit Verzweigungen. Eine
lineare Schrittfolge wird aufgezählt, nicht gezeichnet.

Erzeugt wird es mit dem Skill `diagram-design`, als SVG exportiert, der Pfad
steht im Plan unter `diagram.svgPath`. planify bettet das SVG inline ein und
entfernt dabei `script`, `on*`-Attribute und den Google-Fonts-Import, damit die
Plan-Datei offline-fest bleibt.

Auch der Skill kommt über ein Preset. Er liegt in einem fremden Repo ohne Tags,
deshalb klonst du selbst und gibst den Pfad mit:

```sh
git clone https://github.com/cathrynlavery/diagram-design.git
npx opencode-presets install skill-diagram-design --set skillsDir="$PWD/diagram-design/skills"
```

Ohne diesen Skill bleibt `diagram` einfach weg — handgeschriebene SVG oder
Mermaid-Blöcke gehören nicht in den Plan.
