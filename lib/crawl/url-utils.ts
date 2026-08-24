/**
 * URL helpers for the Sync Flo crawler.
 *
 * This file deliberately contains no fetching/DNS logic. SSRF protection
 * belongs in lib/crawl/ssrf.ts.
 */

const SKIP_EXTENSIONS =
  /\.(?:avif|bmp|css|csv|doc|docx|eot|gif|ico|jpe?g|js|json|map|mp3|mp4|mpeg|ogg|otf|pdf|png|ppt|pptx|rar|rss|svg|tar|tiff?|ttf|txt|wav|webm|webp|woff2?|xls|xlsx|xml|zip)$/i

const LOW_VALUE_PATHS =
  /\/(?:wp-admin|wp-login|admin|login|logout|cart|basket|checkout|account|my-account|feed|tag|author|search)(?:\/|$)/i

export function canonicalizeUrl(rawUrl: string, baseUrl?: string): string | null {
  try {
    const url = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl)

    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (url.username || url.password) return null

    url.hash = ""

    // Normalise hostname/protocol casing and default ports.
    url.hostname = url.hostname.toLowerCase()
    if (
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    ) {
      url.port = ""
    }

    // Remove common tracking parameters while preserving meaningful query params.
    for (const key of Array.from(url.searchParams.keys())) {
      const lower = key.toLowerCase()
      if (
        lower.startsWith("utm_") ||
        ["gclid", "fbclid", "msclkid", "mc_cid", "mc_eid"].includes(lower)
      ) {
        url.searchParams.delete(key)
      }
    }

    // Avoid treating "/" and a trailing slash version of the same path as
    // different crawl targets.
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, "")
    }

    return url.href
  } catch {
    return null
  }
}

export function isSameSite(rawUrl: string, rootHostname: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "")
    const root = rootHostname.toLowerCase().replace(/^www\./, "")
    return hostname === root
  } catch {
    return false
  }
}

export function isCrawlableUrl(rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  if (url.username || url.password) return false

  const path = url.pathname.toLowerCase()

  if (SKIP_EXTENSIONS.test(path)) return false
  if (LOW_VALUE_PATHS.test(path)) return false

  return true
}

export function tokenize(value: string): string[] {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "at",
    "by",
    "for",
    "from",
    "in",
    "of",
    "on",
    "or",
    "the",
    "to",
    "with",
    "uk",
  ])

  return Array.from(
    new Set(
      value
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter((token) => token.length >= 2 && !stopWords.has(token)),
    ),
  )
}

export function urlPriority(rawUrl: string): number {
  try {
    const url = new URL(rawUrl)
    const path = url.pathname.toLowerCase()
    const depth = path.split("/").filter(Boolean).length

    let score = 100 - depth * 10

    if (path === "/" || path === "") score += 100
    if (/(service|services|solution|solutions|what-we-do)/.test(path)) score += 40
    if (/(location|locations|areas-we-cover|areas-covered|coverage|where-we-work)/.test(path)) {
      score += 35
    }
    if (/(contact|get-in-touch|quote|enquir)/.test(path)) score += 25
    if (/(about|our-team|meet-the-team)/.test(path)) score += 10
    if (/(blog|news|article|category|tag|author)/.test(path)) score -= 30

    // Prefer clean URLs over query-heavy variants.
    score -= Array.from(url.searchParams.keys()).length * 5

    return score
  } catch {
    return -1000
  }
}
