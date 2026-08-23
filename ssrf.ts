import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

export const MAX_REDIRECTS = 5
export const DEFAULT_TIMEOUT_MS = 10_000
export const MAX_RESPONSE_BYTES = 2_000_000

const BROWSER_UA =
  "Mozilla/5.0 (compatible; SyncFloVisibilityBot/1.0; +https://syncflo.co.uk/)"

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
  if (n === null) return true
  const inRange = (base: string, maskBits: number) => {
    const baseInt = ipv4ToInt(base)!
    const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0
    return (n & mask) === (baseInt & mask)
  }
  return (
    inRange("0.0.0.0", 8) || inRange("10.0.0.0", 8) ||
    inRange("100.64.0.0", 10) || inRange("127.0.0.0", 8) ||
    inRange("169.254.0.0", 16) || inRange("172.16.0.0", 12) ||
    inRange("192.0.0.0", 24) || inRange("192.0.2.0", 24) ||
    inRange("192.168.0.0", 16) || inRange("198.18.0.0", 15) ||
    inRange("198.51.100.0", 24) || inRange("203.0.113.0", 24) ||
    inRange("224.0.0.0", 4) || inRange("240.0.0.0", 4)
  )
}

function isBlockedIPv6(raw: string): boolean {
  const ip = raw.toLowerCase().split("%")[0]
  const mapped = ip.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (mapped) return isBlockedIPv4(mapped[1])
  if (ip === "::" || ip === "::1") return true
  const firstHextet = ip.split(":")[0] || "0"
  const head = Number.parseInt(firstHextet.padStart(4, "0").slice(0, 4), 16)
  if ((head & 0xfe00) === 0xfc00) return true
  if ((head & 0xffc0) === 0xfe80) return true
  if ((head & 0xff00) === 0xff00) return true
  return false
}

export function isBlockedIP(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) return isBlockedIPv4(ip)
  if (kind === 6) return isBlockedIPv6(ip)
  return true
}

export class UrlRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UrlRejectedError"
  }
}

export async function assertPublicUrl(rawUrl: string): Promise<string> {
  let url: URL
  try { url = new URL(rawUrl) }
  catch { throw new UrlRejectedError("Malformed URL.") }

  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new UrlRejectedError("Only http and https protocols are allowed.")
  if (url.username || url.password)
    throw new UrlRejectedError("URLs containing credentials are not allowed.")

  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  const lowerHost = hostname.toLowerCase()
  if (
    lowerHost === "localhost" || lowerHost.endsWith(".localhost") ||
    lowerHost === "metadata.google.internal" || lowerHost.endsWith(".internal") ||
    lowerHost.endsWith(".local")
  ) throw new UrlRejectedError("Host is not a public website.")

  if (isIP(hostname)) {
    if (isBlockedIP(hostname)) throw new UrlRejectedError("IP address is not publicly routable.")
    return url.href
  }

  let addresses: { address: string }[]
  try { addresses = await lookup(hostname, { all: true }) }
  catch { throw new UrlRejectedError("Host could not be resolved.") }
  if (addresses.length === 0) throw new UrlRejectedError("Host could not be resolved.")
  for (const { address } of addresses) {
    if (isBlockedIP(address)) throw new UrlRejectedError("Host resolves to a non-public address.")
  }
  return url.href
}

export type SafeFetchResult = {
  finalUrl: string; status: number; ok: boolean; contentType: string;
  html: string | null; truncated: boolean; redirected: boolean
}

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
        method: "GET", redirect: "manual", signal: controller.signal,
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-GB,en;q=0.9",
        },
        cache: "no-store",
      })
    } catch (err) {
      clearTimeout(timer)
      if (err instanceof Error && err.name === "AbortError") throw new UrlRejectedError("Request timed out.")
      throw new UrlRejectedError("Request failed.")
    }
    clearTimeout(timer)

    const status = response.status
    if (status >= 300 && status < 400 && response.headers.has("location")) {
      const location = response.headers.get("location") as string
      let nextUrl: string
      try { nextUrl = new URL(location, currentUrl).href }
      catch { throw new UrlRejectedError("Invalid redirect target.") }
      currentUrl = await assertPublicUrl(nextUrl)
      redirected = true
      await response.body?.cancel().catch(() => {})
      continue
    }

    const contentType = response.headers.get("content-type") ?? ""
    const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType)
    const declaredLength = Number(response.headers.get("content-length") ?? "0")
    if (declaredLength && declaredLength > maxBytes) {
      await response.body?.cancel().catch(() => {})
      return { finalUrl: currentUrl, status, ok: response.ok, contentType, html: null, truncated: true, redirected }
    }
    if (!isHtml || !response.body) {
      await response.body?.cancel().catch(() => {})
      return { finalUrl: currentUrl, status, ok: response.ok, contentType, html: null, truncated: false, redirected }
    }

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
    } catch { truncated = true }

    const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8")
    return { finalUrl: currentUrl, status, ok: response.ok, contentType, html, truncated, redirected }
  }
  throw new UrlRejectedError("Too many redirects.")
}
