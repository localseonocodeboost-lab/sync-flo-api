import { parse, type HTMLElement } from "node-html-parser"
import { canonicalizeUrl, isCrawlableUrl, isSameSite, tokenize } from "./url-utils"

/**
 * Deterministic HTML analysis. Extracts factual evidence only — no scoring,
 * no AI opinions. The Sync Flo audit engine consumes these facts downstream.
 */

export type PageType = "homepage" | "service" | "location" | "contact" | "about" | "other"

export type LinkRef = { url: string; anchor: string }

export type PageAnalysis = {
  url: string
  finalUrl: string
  status: number
  httpsActive: boolean
  fetchOk: boolean
  pageType: PageType
  title: string | null
  metaDescription: string | null
  h1: string[]
  h2: string[]
  canonical: string | null
  metaRobots: string | null
  indexable: boolean
  wordCount: number
  serviceMentioned: boolean
  serviceMentionCount: number
  serviceInTitle: boolean
  serviceInH1: boolean
  locationMentioned: boolean
  locationMentionCount: number
  locationInTitle: boolean
  locationInH1: boolean
  businessNameMentioned: boolean
  phoneNumbers: string[]
  emailAddresses: string[]
  postalAddresses: string[]
  internalLinks: LinkRef[]
  externalLinks: LinkRef[]
  schemaTypes: string[]
  contentFingerprint: string | null
  shingles: number[]
  error?: string
}

type Occurrence = { mentioned: boolean; count: number; inTitle: boolean; inH1: boolean }

const PHONE_REGEX =
  /(?:(?:\+|00)\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)\d{3,4}[\s.-]?\d{3,4}/g
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

function textContent(root: HTMLElement): string {
  // Remove non-visible / non-content nodes before extracting text.
  for (const tag of ["script", "style", "noscript", "template", "svg", "iframe"]) {
    for (const el of root.querySelectorAll(tag)) el.remove()
  }
  return root.structuredText.replace(/\s+/g, " ").trim()
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

/**
 * Term occurrence across title / H1 / body. Matches the full phrase and also
 * requires *all* significant tokens to be present for the "mentioned" flag,
 * so a multi-word service isn't falsely matched by one common word.
 */
function analyzeOccurrence(
  term: string,
  title: string,
  h1Text: string,
  bodyText: string,
): Occurrence {
  const termLower = term.toLowerCase().trim()
  const tokens = tokenize(term)
  const bodyLower = bodyText.toLowerCase()
  const titleLower = title.toLowerCase()
  const h1Lower = h1Text.toLowerCase()

  const phraseCount = countOccurrences(bodyLower, termLower)
  const allTokensPresent =
    tokens.length > 0 && tokens.every((t) => bodyLower.includes(t))

  const mentioned = phraseCount > 0 || allTokensPresent
  const count = phraseCount > 0 ? phraseCount : allTokensPresent ? 1 : 0

  const inTitle =
    titleLower.includes(termLower) ||
    (tokens.length > 0 && tokens.every((t) => titleLower.includes(t)))
  const inH1 =
    h1Lower.includes(termLower) ||
    (tokens.length > 0 && tokens.every((t) => h1Lower.includes(t)))

  return { mentioned, count, inTitle, inH1 }
}

function extractSchemaTypes(root: HTMLElement): string[] {
  const types = new Set<string>()

  // JSON-LD blocks.
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = script.rawText || script.text
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw)
      collectTypes(parsed, types)
    } catch {
      // Malformed JSON-LD is common — record that it exists but is unparsable.
      types.add("__unparsable_jsonld__")
    }
  }

  // Microdata itemtype (record the trailing type name).
  for (const el of root.querySelectorAll("[itemtype]")) {
    const itemtype = el.getAttribute("itemtype")
    if (itemtype) {
      const name = itemtype.split("/").filter(Boolean).pop()
      if (name) types.add(name)
    }
  }

  return Array.from(types)
}

function collectTypes(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectTypes(item, out)
    return
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>
    const type = obj["@type"]
    if (typeof type === "string") out.add(type)
    else if (Array.isArray(type)) for (const t of type) if (typeof t === "string") out.add(t)

    if (Array.isArray(obj["@graph"])) collectTypes(obj["@graph"], out)
    // Recurse into nested objects (e.g. nested Organization, address, etc.).
    for (const key of Object.keys(obj)) {
      if (key === "@type" || key === "@graph") continue
      const value = obj[key]
      if (value && typeof value === "object") collectTypes(value, out)
    }
  }
}

function extractPostalAddresses(root: HTMLElement, bodyText: string): string[] {
  const addresses = new Set<string>()

  for (const el of root.querySelectorAll("address")) {
    const t = el.structuredText.replace(/\s+/g, " ").trim()
    if (t.length > 5) addresses.add(t)
  }

  // UK-style postcode as a strong address signal.
  const postcodeRegex = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi
  const matches = bodyText.match(postcodeRegex)
  if (matches) for (const m of matches.slice(0, 5)) addresses.add(m.trim())

  return Array.from(addresses).slice(0, 10)
}

function normalizePhone(raw: string): string {
  return raw.replace(/[^\d+]/g, "")
}

function extractPhones(root: HTMLElement, bodyText: string): string[] {
  const found = new Set<string>()

  // tel: links are the most reliable source.
  for (const a of root.querySelectorAll('a[href^="tel:"]')) {
    const href = a.getAttribute("href") ?? ""
    const num = href.replace(/^tel:/i, "").trim()
    if (num) found.add(num)
  }

  const matches = bodyText.match(PHONE_REGEX) ?? []
  for (const m of matches) {
    const normalized = normalizePhone(m)
    // Filter out things too short/long to be a real phone number.
    if (normalized.replace("+", "").length >= 9 && normalized.replace("+", "").length <= 15) {
      found.add(m.trim())
    }
  }

  return Array.from(found).slice(0, 10)
}

function extractEmails(root: HTMLElement, bodyText: string): string[] {
  const found = new Set<string>()

  for (const a of root.querySelectorAll('a[href^="mailto:"]')) {
    const href = a.getAttribute("href") ?? ""
    const email = href.replace(/^mailto:/i, "").split("?")[0].trim()
    if (email) found.add(email.toLowerCase())
  }

  const matches = bodyText.match(EMAIL_REGEX) ?? []
  for (const m of matches) {
    // Ignore emails that are actually filenames/sentry keys etc.
    if (!/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(m)) found.add(m.toLowerCase())
  }

  return Array.from(found).slice(0, 10)
}

/** Simple, deterministic 64-bit-ish content fingerprint (FNV-1a hash of text). */
function fingerprint(text: string): string | null {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim()
  if (!normalized) return null
  // FNV-1a 32-bit, expressed as hex; good enough for exact/near-dup grouping.
  let hash = 0x811c9dc5
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

/** Word-level shingle hashes for Jaccard similarity between pages. */
function computeShingles(text: string, size = 4, limit = 200): number[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length < size) return []
  const set = new Set<number>()
  for (let i = 0; i + size <= words.length; i++) {
    const shingle = words.slice(i, i + size).join(" ")
    let hash = 0x811c9dc5
    for (let j = 0; j < shingle.length; j++) {
      hash ^= shingle.charCodeAt(j)
      hash = Math.imul(hash, 0x01000193)
    }
    set.add(hash >>> 0)
  }
  return Array.from(set)
    .sort((a, b) => a - b)
    .slice(0, limit)
}

export function jaccardSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setB = new Set(b)
  let intersection = 0
  for (const x of a) if (setB.has(x)) intersection++
  const union = a.length + b.length - intersection
  return union === 0 ? 0 : Number((intersection / union).toFixed(3))
}

function classifyPage(
  url: string,
  isHomepage: boolean,
  title: string,
  h1Text: string,
  service: string,
  location: string,
): PageType {
  if (isHomepage) return "homepage"

  let path = "/"
  try {
    path = new URL(url).pathname.toLowerCase()
  } catch {
    /* keep default */
  }
  const hay = `${path} ${title.toLowerCase()} ${h1Text.toLowerCase()}`

  if (/(contact|get-in-touch|enquir|quote)/.test(hay)) return "contact"
  if (/(about|who-we-are|our-story|meet-the-team|our-team)/.test(hay)) return "about"

  const locationTokens = tokenize(location)
  const locationHit = locationTokens.some((t) => hay.includes(t))
  const areaPattern =
    /(areas?-we-cover|areas?-covered|locations?|coverage|towns?|where-we-work|service-area)/
  if (areaPattern.test(hay) || (locationHit && /(area|location|town|region|cover)/.test(hay))) {
    return "location"
  }

  const serviceTokens = tokenize(service)
  const serviceHit = serviceTokens.some((t) => hay.includes(t))
  if (/(services?|solutions?|what-we-do)/.test(hay) || serviceHit) return "service"

  return "other"
}

/**
 * Analyse one fetched HTML document into structured, deterministic evidence.
 */
export function analyzePage(params: {
  requestedUrl: string
  finalUrl: string
  status: number
  ok: boolean
  html: string
  isHomepage: boolean
  rootHostname: string
  businessName: string
  service: string
  location: string
}): PageAnalysis {
  const {
    requestedUrl,
    finalUrl,
    status,
    ok,
    html,
    isHomepage,
    rootHostname,
    businessName,
    service,
    location,
  } = params

  const root = parse(html, {
    lowerCaseTagName: true,
    comment: false,
    blockTextElements: { script: false, noscript: false, style: false, pre: true },
  })

  const title = root.querySelector("title")?.structuredText.trim() || null

  const metaDescription =
    root.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() || null

  const h1 = root
    .querySelectorAll("h1")
    .map((el) => el.structuredText.replace(/\s+/g, " ").trim())
    .filter(Boolean)

  const h2 = root
    .querySelectorAll("h2")
    .map((el) => el.structuredText.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 20)

  const canonical =
    root.querySelector('link[rel="canonical"]')?.getAttribute("href")?.trim() || null

  const metaRobots =
    root.querySelector('meta[name="robots"]')?.getAttribute("content")?.trim().toLowerCase() ||
    null

  const indexable = !(metaRobots?.includes("noindex") ?? false)

  const schemaTypes = extractSchemaTypes(root)

  // Extract visible text AFTER schema extraction (textContent strips <script>).
  const bodyText = textContent(root)
  const wordCount = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0

  const h1Text = h1.join(" ")
  const titleText = title ?? ""

  const serviceOcc = analyzeOccurrence(service, titleText, h1Text, bodyText)
  const locationOcc = analyzeOccurrence(location, titleText, h1Text, bodyText)
  const businessOcc = analyzeOccurrence(businessName, titleText, h1Text, bodyText)

  const phoneNumbers = extractPhones(root, bodyText)
  const emailAddresses = extractEmails(root, bodyText)
  const postalAddresses = extractPostalAddresses(root, bodyText)

  // Link extraction, split into internal (same-site) and external.
  const internalMap = new Map<string, LinkRef>()
  const externalMap = new Map<string, LinkRef>()
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href")
    if (!href) continue
    if (/^(mailto:|tel:|javascript:|#|data:)/i.test(href.trim())) continue
    const canon = canonicalizeUrl(href, finalUrl)
    if (!canon) continue
    const anchor = a.structuredText.replace(/\s+/g, " ").trim().slice(0, 120)
    if (isSameSite(canon, rootHostname)) {
      if (!internalMap.has(canon)) internalMap.set(canon, { url: canon, anchor })
    } else {
      if (!externalMap.has(canon)) externalMap.set(canon, { url: canon, anchor })
    }
  }

  return {
    url: requestedUrl,
    finalUrl,
    status,
    httpsActive: finalUrl.startsWith("https://"),
    fetchOk: ok,
    pageType: classifyPage(finalUrl, isHomepage, titleText, h1Text, service, location),
    title,
    metaDescription,
    h1,
    h2,
    canonical,
    metaRobots,
    indexable,
    wordCount,
    serviceMentioned: serviceOcc.mentioned,
    serviceMentionCount: serviceOcc.count,
    serviceInTitle: serviceOcc.inTitle,
    serviceInH1: serviceOcc.inH1,
    locationMentioned: locationOcc.mentioned,
    locationMentionCount: locationOcc.count,
    locationInTitle: locationOcc.inTitle,
    locationInH1: locationOcc.inH1,
    businessNameMentioned: businessOcc.mentioned,
    phoneNumbers,
    emailAddresses,
    postalAddresses,
    internalLinks: Array.from(internalMap.values()).filter((l) => isCrawlableUrl(l.url)),
    externalLinks: Array.from(externalMap.values()).slice(0, 30),
    schemaTypes,
    contentFingerprint: fingerprint(bodyText),
    shingles: computeShingles(bodyText),
  }
}

export { computeShingles }