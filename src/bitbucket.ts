// Minimaler Client für die REST-API von Bitbucket Data Center: offenen PR eines
// Branches finden und dessen Description ersetzen. Kein PR wird angelegt, kein
// Kommentar geschrieben.

export type RepoRef = { projectKey: string; repoSlug: string }

export type PullRequestRef = RepoRef & { baseUrl: string; id: number }

export type PullRequest = {
  id: number
  version: number
  state: string
  title: string
  targetBranch: string
  url: string
  reviewers: { user: { name: string } }[]
}

export type BitbucketConfig = {
  baseUrl: string
  token: string
  fetch?: typeof fetch
  /** Millisekunden pro Anfrage inklusive Antwort-Body. Standard REQUEST_TIMEOUT_MS. */
  timeoutMs?: number
}

// Ohne Grenze hängt plan_pr und damit die opencode-Sitzung, wenn Bitbucket die
// Verbindung annimmt und nie antwortet (VPN weg, Proxy schluckt).
export const REQUEST_TIMEOUT_MS = 30_000

export class BitbucketError extends Error {
  // Kein Parameter-Property: Node führt das Paket per Type-Stripping aus, und das
  // kennt diese Syntax nicht.
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
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

function repoPath(repo: RepoRef): string {
  return `/rest/api/latest/projects/${encodeURIComponent(repo.projectKey)}/repos/${encodeURIComponent(repo.repoSlug)}`
}

async function request(config: BitbucketConfig, method: string, path: string, body?: unknown): Promise<any> {
  const url = config.baseUrl.replace(/\/+$/, "") + path
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
      throw new BitbucketError(`Bitbucket antwortet nicht innerhalb von ${timeoutMs / 1000} s (${config.baseUrl}).`)
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
  return data
}

function toPullRequest(data: any): PullRequest {
  return {
    id: data.id,
    version: data.version,
    state: data.state,
    title: data.title,
    targetBranch: data.toRef?.displayId ?? data.toRef?.id ?? "?",
    url: data.links?.self?.[0]?.href ?? "",
    reviewers: (data.reviewers ?? []).map((r: any) => ({ user: { name: r.user?.name } })),
  }
}

/** Offene PRs, deren Quelle der Branch ist. Mehrere heisst: verschiedene Ziel-Branches. */
export async function findOpenPullRequests(config: BitbucketConfig, repo: RepoRef, branch: string): Promise<PullRequest[]> {
  const query = new URLSearchParams({ at: `refs/heads/${branch}`, direction: "OUTGOING", state: "OPEN", limit: "25" })
  const data = await request(config, "GET", `${repoPath(repo)}/pull-requests?${query}`)
  return (data?.values ?? []).map(toPullRequest)
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
  try {
    const data = await request(config, "PUT", `${repoPath(repo)}/pull-requests/${id}`, {
      version: pr.version,
      title: pr.title,
      description,
      reviewers: pr.reviewers,
    })
    return toPullRequest(data)
  } catch (error) {
    if (error instanceof BitbucketError && error.status === 409) {
      throw new BitbucketError(
        `PR #${id} wurde gerade von jemand anderem geändert, nichts überschrieben. Erneut versuchen.`,
        409,
      )
    }
    throw error
  }
}
