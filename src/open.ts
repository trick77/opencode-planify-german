// Öffnen der gerenderten Plan-Datei. Bewusst ohne festen Browser: es gewinnt
// der Standard-Handler des Systems, damit planify auf macOS, Linux und Windows
// gleich funktioniert.

export type Platform = "darwin" | "win32" | "linux" | (string & {})

export type OpenOptions = {
  /** Überschreibt das Kommando, z. B. "firefox" oder "flatpak run org.mozilla.firefox". */
  openWith?: string
  platform?: Platform
  env?: Record<string, string | undefined>
}

export type OpenCommand = { command: string; args: string[] }

/**
 * Baut den Befehl, der die Datei im Standard-Browser des Systems öffnet.
 * Reihenfolge der Quellen: explizite Option, Umgebungsvariable PLANIFY_OPEN,
 * Plattform-Standard. `undefined` heisst: kein bekannter Opener, nicht öffnen.
 */
export function buildOpenCommand(path: string, options: OpenOptions = {}): OpenCommand | undefined {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const override = options.openWith?.trim() || env.PLANIFY_OPEN?.trim()

  if (override) {
    // Der Wert darf Argumente enthalten ("flatpak run org.mozilla.firefox"),
    // deshalb wird an Leerzeichen getrennt und ohne Shell ausgeführt.
    const parts = override.split(/\s+/)
    return { command: parts[0], args: [...parts.slice(1), path] }
  }

  if (platform === "darwin") return { command: "open", args: [path] }
  // Der erste Parameter von start ist der Fenstertitel, deshalb der leere String.
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", path] }
  if (platform === "linux") return { command: "xdg-open", args: [path] }
  return undefined
}
