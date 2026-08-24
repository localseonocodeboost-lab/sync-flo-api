/**
 * Deterministic URL handling for the crawler:
 *  - canonicalisation (so duplicates aren't fetched twice)
 *  - filtering out non-useful URLs (admin, cart, files, external, etc.)
 *  - priority scoring so the limited crawl budget targets useful pages
 */

// Tracking / session params that create duplicate URLs; stripped on canonicalise.
const STRIP_QUERY_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "_ga",
  "sessionid",
  "phpsessid",
]

// File extensions we never want to crawl as HTML pages.
const SKIP_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".bmp",
  ".tiff",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
  ".rar",
  ".gz",
  ".tar",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
  ".wmv",
  ".css",
  ".js",
  ".json",
  ".xml",
  ".rss",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
]

// Path fragments that indicate a URL not worth the crawl budget.
const SKIP_PATH_PATTERNS = [
  "/wp-admin",
  "/wp-login",
  "/admin",
  "/administrator",
  "/login",
  "/signin",
  "/sign-in",
  "/logout",
  "/register",
  "/signup",
  "/sign-up",
  "/account",
  "/my-account",
  "/cart",
  "/basket",
  "/checkout",
  "/wishlist",
  "/search",
  "/?s=",
  "/tag/",
  "/tags/",
  "/author/",
  "/feed",
  "/cdn-cgi/",
  "/wp-json",
  "/xmlrpc",
]

export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "")
}

/**
 * Canonicalise a URL for de-duplication:
 *  - lowercase host, drop default ports and fragments
 *  - strip tracking query params, sort the rest
 *  - remove trailing slash (except root)
 */
export function canonicalizeUrl(rawUrl: string, base?: string): string | null {
  let url: URL
  try {
    url = base ? new URL(rawUrl, base) : new URL(rawUrl)
  } catch {
    return null
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null

  url.hash = ""
  url.hostname = url.hostname.toLowerCase()

  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = ""
  }

  for (const param of STRIP_QUERY_PARAMS) {
    url.searchParams.delete(param)
  }
  url.searchParams.sort()

  // Normalise trailing slash on the path (keep root "/").
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "")
  }

  return url.href
}

export function isSameSite(url: string, rootHostname: string): boolean {
  try {
    return normalizeHostname(new URL(url).hostname) === normalizeHostname(rootHostname)
  } catch {
    return false
  }
}

/** Whether a same-site URL is worth spending crawl budget on. */
export function isCrawlableUrl(rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return false

  const path = url.pathname.toLowerCase()

  for (const ext of SKIP_EXTENSIONS) {
    if (path.endsWith(ext)) return false
  }

  const haystack = (url.pathname + url.search).toLowerCase()
  for (const pattern of SKIP_PATH_PATTERNS) {
    if (haystack.includes(pattern)) return false
  }

  // Skip obvious paginated archives (?page=, /page/2) to avoid duplicates.
  if (/\/page\/\d+/.test(path)) return false
  if (url.searchParams.has("page") && Number(url.searchParams.get("page")) > 1) return false

  return true
}

/**
 * Deterministic priority score for crawl ordering. Higher = crawl sooner.
 * Uses only URL/anchor signals — no AI. Intended to surface service, location,
 * about and contact pages within the 15-page budget.
 */
export function urlPriority(
  rawUrl: string,
  anchorText: string,
  service: string,
  location: string,
): number {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return 0
  }

  const path = url.pathname.toLowerCase()
  const anchor = anchorText.toLowerCase()
  const serviceTokens = tokenize(service)
  const locationTokens = tokenize(location)

  let score = 0

  // Shallow pages tend to matter more.
  const depth = path.split("/").filter(Boolean).length
  score += Math.max(0, 5 - depth)

  // Submitted service / location relevance in the path or anchor.
  if (serviceTokens.some((t) => path.includes(t) || anchor.includes(t))) score += 40
  if (locationTokens.some((t) => path.includes(t) || anchor.includes(t))) score += 35

  // Common high-value page patterns.
  if (/(services|service)\b/.test(path)) score += 30
  if (/(areas?-we-cover|areas?-covered|locations?|coverage|towns?|where-we-work)/.test(path))
    score += 28
  if (/(contact)/.test(path) || /contact/.test(anchor)) score += 25
  if (/(about|who-we-are|our-story|meet-the-team)/.test(path)) score += 20
  if (/(pricing|prices|quote|book)/.test(path)) score += 10

  // Slightly prefer HTML-y paths with words over numeric/date slugs.
  if (/\/\d{4}\/\d{2}\//.test(path)) score -= 10 // blog date archives
  if (/\/(blog|news|posts?)\//.test(path)) score -= 5

  return score
}

export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
}
