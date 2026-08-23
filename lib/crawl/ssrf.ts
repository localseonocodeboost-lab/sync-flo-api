import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

/**
 * SSRF protection + safe fetching for the Sync Flo crawler.
 *
 * Public users submit arbitrary URLs, so every request (including each redirect
 * hop) must be validated before a connection is made:
 *  - only http/https
 *  - no embedded credentials (user:pass@host)
 *  - hostname must resolve exclusively to public, routable IP addresses
 *  - block loopback, private, link-local, CGNAT, reserved and metadata ranges
 */

export const MAX_REDIRECTS = 5
export const DEFAULT_TIMEOUT_MS = 10_000
export const MAX_RESPONSE_BYTES = 2_000_000 // 2 MB cap per page

const BROWSER_UA =
  "Mozilla/5.0 (compatible; SyncFloVisibilityBot/1.0; +https://syncflo.example/bot)"

/** Parse an IPv4 dotted string into a 32-bit unsigned integer, or null. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = value * 256 + n
  }
  return value >>> 0
}

function isBlockedIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  if (n === null) return true // unparseable -> treat as unsafe

  const inRange = (base: string, maskBits: number) => {
    const baseInt = ipv4ToInt(base)!
    const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0
    return (n & mask) === (baseInt & mask)
  }

  return (
    inRange("0.0.0.0", 8) || // "this" network / unspecified
    inRange("10.0.0.0", 8) || // private
    inRange("100.64.0.0", 10) || // CGNAT
    inRange("127.0.0.0", 8) || // loopback
    inRange("169.254.0.0", 16) || // link-local (incl. 169.254.169.254 metadata)
    inRange("172.16.0.0", 12) || // private
    inRange("192.0.0.0", 24) || // IETF protocol assignments
    inRange("192.0.2.0", 24) || // TEST-NET-1
    inRange("192.168.0.0", 16) || // private
    inRange("198.18.0.0", 15) || // benchmarking
    inRange("198.51.100.0", 24) || // TEST-NET-2
    inRange("203.0.113.0", 24) || // TEST-NET-3
    inRange("224.0.0.0", 4) || // multicast
    inRange("240.0.0.0", 4) // reserved / broadcast
  )
}

function isBlockedIPv6(raw: string): boolean {
  const ip = raw.toLowerCase().split("%")[0] // strip zone id

  // IPv4-mapped / compat addresses: validate the embedded IPv4.
  const mapped = ip.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (mapped) return isBlockedIPv4(mapped[1])

  if (ip === "::" || ip === "::1") return true // unspecified / loopback

  const firstHextet = ip.split(":")[0] || "0"
  const head = Number.parseInt(firstHextet.padStart(4, "0").slice(0, 4), 16)

  // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast
  if ((head & 0xfe00) === 0xfc00) return true
  if ((head & 0xffc0) === 0xfe80) return true
  if ((head & 0xff00) === 0xff00) return true

  return false
}

export function isBlockedIP(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) return isBlockedIPv4(ip)
  if (kind === 6) return isBlockedIPv6(ip)
  return true // not a valid IP literal -> unsafe
}

export class UrlRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UrlRejectedError"
  }
}

/**
 * Validate a single URL string and confirm its host resolves only to public
 * IP addresses. Returns the normalized href on success, throws UrlRejectedError
 * on any policy violation.
 */
export async function assertPublicUrl(rawUrl: string): Promise<string> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new UrlRejectedError("Malformed URL.")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlRejectedError("Only http and https protocols are allowed.")
  }

  if (url.username || url.password) {
    throw new UrlRejectedError("URLs containing credentials are not allowed.")
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "") // unwrap IPv6 literal

  // Block obvious loopback / metadata hostnames outright.
  const lowerHost = hostname.toLowerCase()
  if (
    lowerHost === "localhost" ||
    lowerHost.endsWith(".localhost") ||
    lowerHost === "metadata.google.internal" ||
    lowerHost.endsWith(".internal") ||
    lowerHost.endsWith(".local")
  ) {
    throw new UrlRejectedError("Host is not a public website.")
  }

  // If the host is an IP literal, validate it directly.
  if (isIP(hostname)) {
    if (isBlockedIP(hostname)) {
      throw new UrlRejectedError("IP address is not publicly routable.")
    }
    return url.href
  }

  // Otherwise resolve DNS and validate every returned address.
  let addresses: { address: string }[]
  try {
    addresses = await lookup(hostname, { all: true })
  } catch {
    throw new UrlRejectedError("Host could not be resolved.")
  }

  if (addresses.length === 0) {
    throw new UrlRejectedError("Host could not be resolved.")
  }

  for (const { address } of addresses) {
    if (isBlockedIP(address)) {
      throw new UrlRejectedError("Host resolves to a non-public address.")
    }
  }

  return url.href
}

export type SafeFetchResult = {
  finalUrl: string
  status: number
  ok: boolean
  contentType: string
  html: string | null
  truncated: boolean
  redirected: boolean
}

/**
 * Fetch a URL with SSRF protection applied to the original request and to every
 * redirect hop. Redirects are followed manually so each Location is re-validated.
 * Non-HTML responses are not downloaded as text.
 */
export async function safeFetch(
  rawUrl: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES

  let currentUrl = await assertPublicUrl(rawUrl)
  let redirected = false

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let response: Response
    try {
      response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-GB,en;q=0.9",
        },
        cache: "no-store",
      })
    } catch (err) {
      clearTimeout(timer)
      if (err instanceof Error && err.name === "AbortError") {
        throw new UrlRejectedError("Request timed out.")
      }
      throw new UrlRejectedError("Request failed.")
    }
    clearTimeout(timer)

    const status = response.status

    // Handle redirects manually and re-validate the target.
    if (status >= 300 && status < 400 && response.headers.has("location")) {
      const location = response.headers.get("location") as string
      let nextUrl: string
      try {
        nextUrl = new URL(location, currentUrl).href
      } catch {
        throw new UrlRejectedError("Invalid redirect target.")
      }
      // Re-run full SSRF validation on the redirect destination.
      currentUrl = await assertPublicUrl(nextUrl)
      redirected = true
      // Drain the redirect body so the socket can be reused.
      await response.body?.cancel().catch(() => {})
      continue
    }

    const contentType = response.headers.get("content-type") ?? ""
    const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType)

    // Enforce declared size limit early when available.
    const declaredLength = Number(response.headers.get("content-length") ?? "0")
    if (declaredLength && declaredLength > maxBytes) {
      await response.body?.cancel().catch(() => {})
      return {
        finalUrl: currentUrl,
        status,
        ok: response.ok,
        contentType,
        html: null,
        truncated: true,
        redirected,
      }
    }

    if (!isHtml || !response.body) {
      // Not HTML (image, PDF, etc.) — don't download as text.
      await response.body?.cancel().catch(() => {})
      return {
        finalUrl: currentUrl,
        status,
        ok: response.ok,
        contentType,
        html: null,
        truncated: false,
        redirected,
      }
    }

    // Stream the body, enforcing the byte cap so a huge page can't exhaust memory.
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    let truncated = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          received += value.byteLength
          if (received > maxBytes) {
            truncated = true
            await reader.cancel().catch(() => {})
            break
          }
          chunks.push(value)
        }
      }
    } catch {
      // Partial read still yields whatever we captured.
      truncated = true
    }

    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)))
    const html = buffer.toString("utf-8")

    return {
      finalUrl: currentUrl,
      status,
      ok: response.ok,
      contentType,
      html,
      truncated,
      redirected,
    }
  }

  throw new UrlRejectedError("Too many redirects.")
}
