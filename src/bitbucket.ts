// Minimaler Client für die REST-API von Bitbucket Data Center: offenen PR eines
// Branches finden, dessen Description ersetzen oder einen Draft-PR anlegen. Kein
// Kommentar wird geschrieben.

export type RepoRef = { projectKey: string; repoSlug: string }

export type PullRequestRef = RepoRef & { baseUrl: string; id: number }

export type PullRequest = {
  id: number
  version: number
  state: string
  title: string
  targetBranch: string
  url: string
  reviewers: Reviewer[]
  draft?: boolean
}

export type Reviewer = { user: { name: string } }

export type Repository = RepoRef & {
  id: number
  /** Angemeldeter Benutzer aus dem Header X-AUSERNAME, falls Bitbucket ihn setzt. */
  currentUser?: string
}

export type BitbucketConfig = {
  baseUrl: string
  token: string
  fetch?: typeof fetch
  /** Millisekunden pro Anfrage inklusive Antwort-Body. Standard REQUEST_TIMEOUT_MS. */
  timeoutMs?: number
}

// Ohne Grenze hängt pr_summary und damit die opencode-Sitzung, wenn Bitbucket die
// Verbindung annimmt und nie antwortet (VPN weg, Proxy schluckt).
export const REQUEST_TIMEOUT_MS = 30_000

export class BitbucketError extends Error {
  // Kein Parameter-Property: Node führt das Paket per Type-Stripping aus, und das
  // kennt diese Syntax nicht.
  readonly status?: number
  /** Anfrage abgeschickt, Antwort kam nicht rechtzeitig: sie kann durchgegangen sein. */
  readonly timedOut: boolean

  constructor(message: string, status?: number, timedOut = false) {
    super(message)
    this.status = status
    this.timedOut = timedOut
  }
}

/** Ein schreibender Aufruf ist vielleicht durchgegangen; "nicht geändert" wäre falsch. */
export class UncertainOutcomeError extends BitbucketError {}

// 2xx ohne brauchbare Antwort oder Timeout nach dem Absenden: der Schreibvorgang kann
// durch sein.
function isUncertain(error: unknown): error is BitbucketError {
  return error instanceof BitbucketError && (error.timedOut || (error.status !== undefined && error.status < 300))
}

/**
 * Projekt und Repository aus der Remote-URL. Der Host wird nicht genutzt: bei SSH
 * stimmt er nicht mit der Web-URL überein, die kommt aus der Konfiguration.
 *
 * https://host[/kontext]/scm/PROJ/repo.git, ssh://git@host:7999/proj/repo.git,
 * git@host:proj/repo.git, persönliche Repos mit ~user als Projekt.
 */
export function parseRemote(remoteUrl: string): RepoRef {
  const url = remoteUrl.trim()
  let path: string
  const scpMatch = url.match(/^[^/@]+@[^:/]+:(.+)$/)
  if (scpMatch) {
    path = scpMatch[1]
  } else {
    try {
      path = new URL(url).pathname
    } catch {
      throw new BitbucketError(`Remote-URL nicht erkannt: ${url}`)
    }
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    throw new BitbucketError(`Remote-URL nicht erkannt: ${url}`)
  }
  const parts = decoded.replace(/\.git$/, "").split("/").filter(Boolean)
  if (parts.length < 2) throw new BitbucketError(`Remote-URL enthält kein Projekt/Repository: ${url}`)
  const [projectKey, repoSlug] = parts.slice(-2)
  return { projectKey, repoSlug }
}

/**
 * Zerlegt eine PR-URL aus dem Browser:
 * https://host[/kontext]/projects/PROJ/repos/repo/pull-requests/123[/overview]
 * oder https://host/users/name/repos/repo/pull-requests/123.
 */
export function parsePullRequestUrl(prUrl: string): PullRequestRef {
  const match = prUrl
    .trim()
    .match(/^(https?:\/\/[^?#]+?)\/(projects|users)\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)(?:[/?#].*)?$/)
  if (!match) {
    throw new BitbucketError(
      `PR-URL nicht erkannt: ${prUrl}. Erwartet: https://<host>/projects/<PROJ>/repos/<repo>/pull-requests/<nummer>`,
    )
  }
  const [, baseUrl, kind, owner, repoSlug, id] = match
  return {
    baseUrl,
    projectKey: kind === "users" ? `~${owner}` : owner,
    repoSlug,
    id: Number(id),
  }
}

/** Vergleichbare Form einer Basis-URL: Origin plus Kontextpfad, ohne Schrägstrich am Ende. */
export function normalizeBaseUrl(url: string): string {
  const parsed = new URL(url)
  return parsed.origin + parsed.pathname.replace(/\/+$/, "")
}

function repoPath(repo: RepoRef): string {
  return `/rest/api/latest/projects/${encodeURIComponent(repo.projectKey)}/repos/${encodeURIComponent(repo.repoSlug)}`
}

async function request(config: BitbucketConfig, method: string, path: string, body?: unknown): Promise<any> {
  return (await requestWithHeaders(config, method, path, body)).data
}

async function requestWithHeaders(
  config: BitbucketConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ data: any; headers: Headers }> {
  // baseUrl ist normalisiert (normalizeBaseUrl), der Pfad beginnt mit "/".
  const url = config.baseUrl + path
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? REQUEST_TIMEOUT_MS
  const signal = AbortSignal.timeout(timeoutMs)
  let response: Response
  let text: string
  try {
    response = await doFetch(url, {
      signal,
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    text = await response.text()
  } catch (error) {
    if (signal.aborted) {
      throw new BitbucketError(
        `Bitbucket antwortet nicht innerhalb von ${timeoutMs / 1000} s (${config.baseUrl}).`,
        undefined,
        true,
      )
    }
    throw new BitbucketError(`Bitbucket nicht erreichbar (${config.baseUrl}): ${(error as Error).message}`)
  }
  let data: any
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = undefined
  }
  if (!response.ok) {
    const message = data?.errors?.map((e: any) => e.message).filter(Boolean).join("; ") || response.statusText
    throw new BitbucketError(`Bitbucket antwortet ${response.status} auf ${method} ${path}: ${message}`, response.status)
  }
  // 2xx ohne JSON-Objekt: typisch die Login-Seite eines SSO-Proxys. Nicht als leere
  // Antwort weiterreichen, sonst hiesse es "kein offener PR" statt Anmeldeproblem.
  if (!data || typeof data !== "object") {
    throw new BitbucketError(
      `Bitbucket antwortet ${response.status} auf ${method} ${path} ohne JSON (Login-Seite eines Proxys? Token und URL prüfen).`,
      response.status,
    )
  }
  return { data, headers: response.headers }
}

function toPullRequest(data: any): PullRequest {
  if (typeof data.id !== "number" || typeof data.version !== "number") {
    throw new BitbucketError("Antwort von Bitbucket ist kein Pull-Request (id/version fehlen).")
  }
  return {
    id: data.id,
    version: data.version,
    state: data.state,
    title: data.title,
    targetBranch: data.toRef?.displayId ?? data.toRef?.id ?? "?",
    url: data.links?.self?.[0]?.href ?? "",
    // Nur Reviewer mit Namen: ein {user:{}} lässt Bitbucket das ganze Update ablehnen.
    reviewers: (data.reviewers ?? [])
      .filter((r: any) => typeof r.user?.name === "string")
      .map((r: any) => ({ user: { name: r.user.name } })),
    draft: typeof data.draft === "boolean" ? data.draft : undefined,
  }
}

/** Repository-ID (braucht die Default-Reviewer-API) und, falls gesetzt, der angemeldete Benutzer. */
export async function getRepository(config: BitbucketConfig, repo: RepoRef): Promise<Repository> {
  const { data, headers } = await requestWithHeaders(config, "GET", repoPath(repo))
  if (typeof data.id !== "number") throw new BitbucketError("Antwort von Bitbucket ist kein Repository (id fehlt).")
  return { ...repo, id: data.id, currentUser: headers.get("X-AUSERNAME") ?? undefined }
}

/**
 * Default-Reviewer für Quelle und Ziel. Anders als die Oberfläche setzt die REST-API
 * sie beim Anlegen nicht selbst.
 */
export async function getDefaultReviewers(
  config: BitbucketConfig,
  repo: Repository,
  fromBranch: string,
  toBranch: string,
): Promise<Reviewer[]> {
  const query = new URLSearchParams({
    sourceRepoId: String(repo.id),
    targetRepoId: String(repo.id),
    sourceRefId: `refs/heads/${fromBranch}`,
    targetRefId: `refs/heads/${toBranch}`,
  })
  const path =
    `/rest/default-reviewers/1.0/projects/${encodeURIComponent(repo.projectKey)}` +
    `/repos/${encodeURIComponent(repo.repoSlug)}/reviewers?${query}`
  const data = await request(config, "GET", path)
  if (!Array.isArray(data)) throw new BitbucketError("Antwort von Bitbucket enthält keine Reviewer-Liste.")
  return data.filter((u: any) => typeof u?.name === "string").map((u: any) => ({ user: { name: u.name } }))
}

export type NewPullRequest = {
  title: string
  description: string
  fromBranch: string
  toBranch: string
  reviewers: Reviewer[]
}

/**
 * Legt einen Draft-PR an (Drafts ab Bitbucket DC 8.18). Ältere Instanzen ignorieren
 * `draft` still; ob es ein Draft wurde, steht in `draft` der Rückgabe.
 */
export async function createPullRequest(config: BitbucketConfig, repo: RepoRef, pr: NewPullRequest): Promise<PullRequest> {
  const repository = { slug: repo.repoSlug, project: { key: repo.projectKey } }
  let data: any
  try {
    data = await request(config, "POST", `${repoPath(repo)}/pull-requests`, {
      title: pr.title,
      description: pr.description,
      draft: true,
      fromRef: { id: `refs/heads/${pr.fromBranch}`, repository },
      toRef: { id: `refs/heads/${pr.toBranch}`, repository },
      reviewers: pr.reviewers,
    })
  } catch (error) {
    if (isUncertain(error)) throw uncertain(error.message)
    if (error instanceof BitbucketError && (error.status === 401 || error.status === 403)) {
      throw new BitbucketError(`${error.message} Zum Anlegen braucht der Token Schreibrecht auf das Repository.`, error.status)
    }
    throw error
  }
  try {
    return toPullRequest(data)
  } catch (error) {
    throw uncertain((error as Error).message)
  }

  function uncertain(message: string) {
    return new UncertainOutcomeError(`${message} Ob der PR angelegt wurde, im Bitbucket prüfen, bevor erneut angelegt wird.`)
  }
}

/** Offene PRs, deren Quelle der Branch ist. Mehrere heisst: verschiedene Ziel-Branches. */
export async function findOpenPullRequests(config: BitbucketConfig, repo: RepoRef, branch: string): Promise<PullRequest[]> {
  const query = new URLSearchParams({ at: `refs/heads/${branch}`, direction: "OUTGOING", state: "OPEN", limit: "25" })
  const data = await request(config, "GET", `${repoPath(repo)}/pull-requests?${query}`)
  if (!Array.isArray(data.values)) throw new BitbucketError("Antwort von Bitbucket enthält keine PR-Liste.")
  return data.values.map(toPullRequest)
}

export async function getPullRequest(config: BitbucketConfig, repo: RepoRef, id: number): Promise<PullRequest> {
  return toPullRequest(await request(config, "GET", `${repoPath(repo)}/pull-requests/${id}`))
}

/**
 * Ersetzt die Description. Titel und Reviewer gehen unverändert mit, damit kein
 * fehlendes Feld beim PUT als leer gelesen wird. Die Version ist Optimistic
 * Locking: 409 heisst, jemand hat den PR zwischen Lesen und Schreiben geändert.
 * Dann wird nicht wiederholt, sonst ginge dessen Änderung kommentarlos verloren.
 */
export async function setDescription(
  config: BitbucketConfig,
  repo: RepoRef,
  id: number,
  description: string,
): Promise<PullRequest> {
  const pr = await getPullRequest(config, repo, id)
  if (pr.state !== "OPEN") {
    throw new BitbucketError(`PR #${id} ist ${pr.state}, nicht offen. Description nicht geändert.`)
  }
  const uncertain = (message: string) =>
    new UncertainOutcomeError(`${message} Ob die Description geschrieben wurde, im PR #${id} prüfen.`)
  let data: any
  try {
    data = await request(config, "PUT", `${repoPath(repo)}/pull-requests/${id}`, {
      version: pr.version,
      title: pr.title,
      description,
      reviewers: pr.reviewers,
      // Ohne das Feld könnte ein Draft beim Update veröffentlicht werden.
      ...(pr.draft === undefined ? {} : { draft: pr.draft }),
    })
  } catch (error) {
    if (error instanceof BitbucketError && error.status === 409) {
      throw new BitbucketError(
        `PR #${id} wurde gerade von jemand anderem geändert, nichts überschrieben. Erneut versuchen.`,
        409,
      )
    }
    if (isUncertain(error)) throw uncertain(error.message)
    throw error
  }
  try {
    return toPullRequest(data)
  } catch (error) {
    throw uncertain((error as Error).message)
  }
}
