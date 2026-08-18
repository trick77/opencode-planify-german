// Öffnen der gerenderten Plan-Datei. Bewusst ohne festen Browser: es gewinnt
// der Standard-Handler des Systems, damit planify auf macOS, Linux und Windows
// gleich funktioniert.

export type Plattform = "darwin" | "win32" | "linux" | (string & {})

export type OeffnenOptionen = {
  /** Überschreibt das Kommando, z. B. "firefox" oder "flatpak run org.mozilla.firefox". */
  openWith?: string
  plattform?: Plattform
  env?: Record<string, string | undefined>
}

export type Befehl = { kommando: string; argumente: string[] }

/**
 * Baut den Befehl, der die Datei im Standard-Browser des Systems öffnet.
 * Reihenfolge der Quellen: explizite Option, Umgebungsvariable PLANIFY_OPEN,
 * Plattform-Standard. `undefined` heisst: kein bekannter Opener, nicht öffnen.
 */
export function baueOeffnenBefehl(pfad: string, optionen: OeffnenOptionen = {}): Befehl | undefined {
  const plattform = optionen.plattform ?? process.platform
  const env = optionen.env ?? process.env
  const ueberschrieben = optionen.openWith?.trim() || env.PLANIFY_OPEN?.trim()

  if (ueberschrieben) {
    // Der Wert darf Argumente enthalten ("flatpak run org.mozilla.firefox"),
    // deshalb wird an Leerzeichen getrennt und ohne Shell ausgeführt.
    const teile = ueberschrieben.split(/\s+/)
    return { kommando: teile[0], argumente: [...teile.slice(1), pfad] }
  }

  if (plattform === "darwin") return { kommando: "open", argumente: [pfad] }
  // Der erste Parameter von start ist der Fenstertitel, deshalb der leere String.
  if (plattform === "win32") return { kommando: "cmd", argumente: ["/c", "start", "", pfad] }
  if (plattform === "linux") return { kommando: "xdg-open", argumente: [pfad] }
  return undefined
}
