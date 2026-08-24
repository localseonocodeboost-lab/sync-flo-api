import { type NextRequest, NextResponse } from "next/server"
import { corsHeaders, corsJson, corsOptions } from "../../../lib/cors"
import { safeFetch, assertPublicUrl, UrlRejectedError } from "../../../lib/crawl/ssrf"
import {
  canonicalizeUrl,
  isCrawlableUrl,
  isSameSite,
  urlPriority,
} from "../../../lib/crawl/url-utils"
import {
  analyzePage,
  jaccardSimilarity,
  type PageAnalysis,
} from "../../../lib/crawl/analyze"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

const MAX_PAGES = 15
const MIN_PAGES = 1
const DEFAULT_MAX_PAGES = 15

const DEFAULT_PER_PAGE_TIMEOUT_MS = 10_000
const MIN_PER_PAGE_TIMEOUT_MS = 2_000
const MAX_PER_PAGE_TIMEOUT_MS = 10_000

const DEFAULT_CONCURRENCY = 1
const MIN_CONCURRENCY = 1
const MAX_CONCURRENCY = 3

type CrawlRequestBody = {
  website?: unknown
  businessName?: unknown
  service?: unknown
  location?: unknown
  maxPages?: unknown
  perPageTimeoutMs?: unknown
  concurrency?: unknown
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function normalizeWebsiteInput(value: unknown): string | null {
  if (!isNonEmptyString(value)) return null

  let normalized = value.trim()

  // Remove accidental escaping such as:
  // www\.syncflo\.co\.uk -> www.syncflo.co.uk
  normalized = normalized.replace(/\\/g, "")

  // Accept normal domain input without forcing users to type a protocol.
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`
  }

  return normalized
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN

  if (!Number.isFinite(n)) return fallback

  return Math.min(
    max,
    Math.max(min, Math.floor(n)),
  )
}

function jsonError(
  request: NextRequest,
  message: string,
  status: number,
) {
  return corsJson(
    request,
    {
      crawlStatus: "unavailable",
      error: message,
    },
    status,
  )
}

type QueueItem = {
  url: string
  anchor: string
  priority: number
}

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request)
}

export async function POST(request: NextRequest) {
  let body: CrawlRequestBody

  try {
    body = (await request.json()) as CrawlRequestBody
  } catch {
    return jsonError(
      request,
      "Invalid JSON body.",
      400,
    )
  }

  const website = normalizeWebsiteInput(body.website)

  const businessName = isNonEmptyString(body.businessName)
    ? body.businessName.trim()
    : null

  const service = isNonEmptyString(body.service)
    ? body.service.trim()
    : null

  const location = isNonEmptyString(body.location)
    ? body.location.trim()
    : null

  const missing: string[] = []

  if (!website) missing.push("website")
  if (!businessName) missing.push("businessName")
  if (!service) missing.push("service")
  if (!location) missing.push("location")

  if (missing.length > 0) {
    return jsonError(
      request,
      `Missing or invalid required field(s): ${missing.join(", ")}.`,
      400,
    )
  }

  // TypeScript cannot infer non-nullability from the missing[] validation above.
  // From this point onward all four required inputs are guaranteed strings.
  const validatedWebsite = website as string
  const validatedBusinessName = businessName as string
  const validatedService = service as string
  const validatedLocation = location as string

  const maxPages = clampInt(
    body.maxPages,
    MIN_PAGES,
    MAX_PAGES,
    DEFAULT_MAX_PAGES,
  )

  const perPageTimeoutMs = clampInt(
    body.perPageTimeoutMs,
    MIN_PER_PAGE_TIMEOUT_MS,
    MAX_PER_PAGE_TIMEOUT_MS,
    DEFAULT_PER_PAGE_TIMEOUT_MS,
  )

  const concurrency = clampInt(
    body.concurrency,
    MIN_CONCURRENCY,
    MAX_CONCURRENCY,
    DEFAULT_CONCURRENCY,
  )

  let startUrl: string

  try {
    startUrl = await assertPublicUrl(validatedWebsite)
  } catch (err) {
    const reason =
      err instanceof UrlRejectedError
        ? err.message
        : "The submitted website could not be validated."

    return corsJson(
      request,
      {
        crawlStatus: "unavailable",
        error: reason,
      },
      400,
    )
  }

  const startedAt = new Date().toISOString()

  let rootHostname: string

  try {
    rootHostname = new URL(startUrl).hostname
  } catch {
    return jsonError(
      request,
      "The submitted website could not be validated.",
      400,
    )
  }

  const canonicalStart =
    canonicalizeUrl(startUrl) ?? startUrl

  const visited = new Set<string>([
    canonicalStart,
  ])

  const queue: QueueItem[] = []
  const pages: PageAnalysis[] = []

  let pagesAttempted = 0
  let pagesSuccessfullyCrawled = 0
  let activeWorkers = 0

  async function crawlOne(
    url: string,
    isHomepage: boolean,
  ): Promise<PageAnalysis> {
    try {
      const result = await safeFetch(url, {
        timeoutMs: perPageTimeoutMs,
      })

      if (!result.html) {
        return failedPage(
          url,
          result.finalUrl,
          result.status,
          result.ok,
          "Non-HTML or empty response.",
        )
      }

      const analysis = analyzePage({
        requestedUrl: url,
        finalUrl: result.finalUrl,
        status: result.status,
        ok: result.ok,
        html: result.html,
        isHomepage,
        rootHostname,
        businessName: validatedBusinessName,
        service: validatedService,
        location: validatedLocation,
      })

      if (result.ok) {
        pagesSuccessfullyCrawled++
      }

      return analysis
    } catch (err) {
      const reason =
        err instanceof UrlRejectedError
          ? err.message
          : "Request failed."

      return failedPage(
        url,
        url,
        0,
        false,
        reason,
      )
    }
  }

  function enqueueLinks(
    analysis: PageAnalysis,
  ) {
    for (const link of analysis.internalLinks) {
      const canon =
        canonicalizeUrl(link.url)

      if (!canon) continue
      if (visited.has(canon)) continue
      if (!isSameSite(canon, rootHostname)) continue
      if (!isCrawlableUrl(canon)) continue

      visited.add(canon)

      queue.push({
        url: canon,
        anchor: link.anchor,
        priority: urlPriority(
          canon,
          link.anchor,
          validatedService,
          validatedLocation,
        ),
      })
    }
  }

  pagesAttempted++

  const homepage = await crawlOne(
    startUrl,
    true,
  )

  pages.push(homepage)

  if (pages.length < maxPages) {
    enqueueLinks(homepage)
  }

  async function worker() {
    while (true) {
      if (pagesAttempted >= maxPages) {
        return
      }

      if (queue.length === 0) {
        if (activeWorkers > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, 15),
          )

          continue
        }

        return
      }

      queue.sort(
        (a, b) =>
          b.priority - a.priority,
      )

      const item = queue.shift()

      if (!item) continue

      pagesAttempted++
      activeWorkers++

      try {
        const analysis =
          await crawlOne(
            item.url,
            false,
          )

        pages.push(analysis)

        if (pages.length < maxPages) {
          enqueueLinks(analysis)
        }
      } finally {
        activeWorkers--
      }
    }
  }

  if (
    queue.length > 0 &&
    pages.length < maxPages
  ) {
    const workerCount = Math.min(
      concurrency,
      Math.max(1, queue.length),
    )

    await Promise.all(
      Array.from(
        { length: workerCount },
        () => worker(),
      ),
    )
  }

  if (
    !homepage.fetchOk &&
    pagesSuccessfullyCrawled === 0
  ) {
    return NextResponse.json(
      {
        crawlStatus: "unavailable",
        error:
          "The website could not be crawled.",
        crawlMeta: {
          pagesAttempted,
          pagesSuccessfullyCrawled,
          startedAt,
          completedAt:
            new Date().toISOString(),
        },
      },
      {
        status: 200,
        headers: corsHeaders(request),
      },
    )
  }

  const serviceEvidence =
    buildServiceEvidence(
      pages,
      validatedService,
    )

  const locationEvidence =
    buildLocationEvidence(
      homepage,
      pages,
      validatedLocation,
    )

  const contactEvidence =
    buildContactEvidence(
      pages,
      validatedBusinessName,
    )

  const schemaEvidence =
    buildSchemaEvidence(
      pages,
    )

  const duplicateEvidence =
    buildDuplicateEvidence(
      pages,
    )

  const completedAt =
    new Date().toISOString()

  const crawlStatus =
    pagesSuccessfullyCrawled === 0
      ? "unavailable"
      : pages.some(
            (p) =>
              !p.fetchOk ||
              p.error,
          )
        ? "partial"
        : "success"

  return NextResponse.json(
    {
      crawlStatus,

      query: {
        website: startUrl,
        businessName,
        service,
        location,
      },

      website: {
        submittedUrl: website,
        finalUrl: homepage.finalUrl,
        rootHostname,
        httpsActive:
          homepage.httpsActive,
        reachable:
          homepage.fetchOk,
      },

      homepage:
        toHomepageEvidence(
          homepage,
        ),

      pages:
        pages.map(
          toPageEvidence,
        ),

      serviceEvidence,
      locationEvidence,
      contactEvidence,
      schemaEvidence,
      duplicateEvidence,

      crawlMeta: {
        pagesAttempted,
        pagesSuccessfullyCrawled,
        maxPages,
        perPageTimeoutMs,
        concurrency,
        maxPagesCeiling:
          MAX_PAGES,
        startedAt,
        completedAt,
      },
    },
    {
      headers:
        corsHeaders(request),
    },
  )
}

function failedPage(
  url: string,
  finalUrl: string,
  status: number,
  ok: boolean,
  error: string,
): PageAnalysis {
  return {
    url,
    finalUrl,
    status,
    httpsActive:
      finalUrl.startsWith("https://"),
    fetchOk: ok,
    pageType: "other",
    title: null,
    metaDescription: null,
    h1: [],
    h2: [],
    canonical: null,
    metaRobots: null,
    indexable: false,
    wordCount: 0,
    serviceMentioned: false,
    serviceMentionCount: 0,
    serviceInTitle: false,
    serviceInH1: false,
    locationMentioned: false,
    locationMentionCount: 0,
    locationInTitle: false,
    locationInH1: false,
    businessNameMentioned: false,
    phoneNumbers: [],
    emailAddresses: [],
    postalAddresses: [],
    internalLinks: [],
    externalLinks: [],
    schemaTypes: [],
    contentFingerprint: null,
    shingles: [],
    error,
  }
}

function toHomepageEvidence(
  p: PageAnalysis,
) {
  return {
    finalUrl: p.finalUrl,
    status: p.status,
    httpsActive:
      p.httpsActive,
    title: p.title,
    metaDescription:
      p.metaDescription,
    h1: p.h1,
    canonical: p.canonical,
    metaRobots:
      p.metaRobots,
    indexable:
      p.indexable,
    businessNameMentioned:
      p.businessNameMentioned,
    serviceMentioned:
      p.serviceMentioned,
    serviceInTitle:
      p.serviceInTitle,
    serviceInH1:
      p.serviceInH1,
    locationMentioned:
      p.locationMentioned,
    locationInTitle:
      p.locationInTitle,
    locationInH1:
      p.locationInH1,
    phoneNumbers:
      p.phoneNumbers,
    emailAddresses:
      p.emailAddresses,
    postalAddresses:
      p.postalAddresses,
    schemaTypes:
      p.schemaTypes,
    internalLinkCount:
      p.internalLinks.length,
    externalLinks:
      p.externalLinks,
    wordCount:
      p.wordCount,
  }
}

function toPageEvidence(
  p: PageAnalysis,
) {
  return {
    url: p.url,
    finalUrl:
      p.finalUrl,
    status: p.status,
    fetchOk:
      p.fetchOk,
    pageType:
      p.pageType,
    title: p.title,
    metaDescription:
      p.metaDescription,
    h1: p.h1,
    canonical:
      p.canonical,
    metaRobots:
      p.metaRobots,
    indexable:
      p.indexable,
    wordCount:
      p.wordCount,
    serviceMentioned:
      p.serviceMentioned,
    serviceMentionCount:
      p.serviceMentionCount,
    serviceInTitle:
      p.serviceInTitle,
    serviceInH1:
      p.serviceInH1,
    locationMentioned:
      p.locationMentioned,
    locationMentionCount:
      p.locationMentionCount,
    locationInTitle:
      p.locationInTitle,
    locationInH1:
      p.locationInH1,
    internalLinkCount:
      p.internalLinks.length,
    schemaTypes:
      p.schemaTypes,
    contentFingerprint:
      p.contentFingerprint,
    ...(p.error
      ? {
          error: p.error,
        }
      : {}),
  }
}

function buildServiceEvidence(
  pages: PageAnalysis[],
  service: string,
) {
  const servicePages =
    pages.filter(
      (p) =>
        p.pageType === "service" &&
        p.fetchOk,
    )

  const dedicated =
    servicePages.filter(
      (p) =>
        p.serviceInTitle ||
        p.serviceInH1 ||
        p.serviceMentionCount >= 3,
    )

  const linkedUrls =
    new Set<string>()

  for (const p of pages) {
    for (const l of p.internalLinks) {
      linkedUrls.add(l.url)
    }
  }

  return {
    submittedService:
      service,

    servicePageCount:
      servicePages.length,

    servicePageUrls:
      servicePages.map(
        (p) => p.finalUrl,
      ),

    dedicatedServicePageExists:
      dedicated.length > 0,

    dedicatedServicePageUrls:
      dedicated.map(
        (p) => p.finalUrl,
      ),

    serviceProminentPages:
      pages
        .filter(
          (p) =>
            p.fetchOk &&
            (
              p.serviceInTitle ||
              p.serviceInH1
            ),
        )
        .map(
          (p) => ({
            url:
              p.finalUrl,

            inTitle:
              p.serviceInTitle,

            inH1:
              p.serviceInH1,
          }),
        ),

    servicePagesInternallyLinked:
      servicePages.map(
        (p) => ({
          url:
            p.finalUrl,

          internallyLinked:
            linkedUrls.has(
              canonicalizeUrl(
                p.finalUrl,
              ) ??
                p.finalUrl,
            ),
        }),
      ),
  }
}

function buildLocationEvidence(
  homepage: PageAnalysis,
  pages: PageAnalysis[],
  location: string,
) {
  const locationPages =
    pages.filter(
      (p) =>
        p.pageType ===
          "location" &&
        p.fetchOk,
    )

  const servicePlusLocation =
    pages.filter(
      (p) =>
        p.fetchOk &&
        p.serviceMentioned &&
        p.locationMentioned,
    )

  return {
    submittedLocation:
      location,

    locationOnHomepage:
      homepage.locationMentioned,

    locationInHomepageTitle:
      homepage.locationInTitle,

    locationInHomepageH1:
      homepage.locationInH1,

    locationPageCount:
      locationPages.length,

    locationPageUrls:
      locationPages.map(
        (p) =>
          p.finalUrl,
      ),

    locationInTitleOrH1Pages:
      pages
        .filter(
          (p) =>
            p.fetchOk &&
            (
              p.locationInTitle ||
              p.locationInH1
            ),
        )
        .map(
          (p) => ({
            url:
              p.finalUrl,

            inTitle:
              p.locationInTitle,

            inH1:
              p.locationInH1,
          }),
        ),

    serviceAndLocationPages:
      servicePlusLocation.map(
        (p) => ({
          url:
            p.finalUrl,

          serviceMentionCount:
            p.serviceMentionCount,

          locationMentionCount:
            p.locationMentionCount,
        }),
      ),
  }
}

function buildContactEvidence(
  pages: PageAnalysis[],
  businessName: string,
) {
  const phones =
    new Set<string>()

  const emails =
    new Set<string>()

  const addresses =
    new Set<string>()

  for (const p of pages) {
    for (const x of p.phoneNumbers) {
      phones.add(x)
    }

    for (const x of p.emailAddresses) {
      emails.add(x)
    }

    for (const x of p.postalAddresses) {
      addresses.add(x)
    }
  }

  const contactPage =
    pages.find(
      (p) =>
        p.pageType ===
          "contact" &&
        p.fetchOk,
    )

  return {
    businessName,

    businessNameFoundOnSite:
      pages.some(
        (p) =>
          p.businessNameMentioned,
      ),

    phoneNumbers:
      Array.from(
        phones,
      ).slice(0, 15),

    emailAddresses:
      Array.from(
        emails,
      ).slice(0, 15),

    postalAddresses:
      Array.from(
        addresses,
      ).slice(0, 15),

    contactPageUrl:
      contactPage
        ? contactPage.finalUrl
        : null,

    distinctPhoneCount:
      phones.size,

    distinctEmailCount:
      emails.size,
  }
}

function buildSchemaEvidence(
  pages: PageAnalysis[],
) {
  const localBusinessTypes =
    new Set([
      "localbusiness",
      "organization",
      "professionalservice",
      "homeandconstructionbusiness",
      "plumber",
      "electrician",
      "hvacbusiness",
      "roofingcontractor",
      "generalcontractor",
      "locksmith",
      "movingcompany",
      "housepainter",
      "cleaningservice",
    ])

  const allTypes =
    new Map<
      string,
      string[]
    >()

  let unparsableFound =
    false

  for (const p of pages) {
    for (
      const t of
        p.schemaTypes
    ) {
      if (
        t ===
        "__unparsable_jsonld__"
      ) {
        unparsableFound =
          true

        continue
      }

      if (
        !allTypes.has(t)
      ) {
        allTypes.set(
          t,
          [],
        )
      }

      allTypes
        .get(t)!
        .push(
          p.finalUrl,
        )
    }
  }

  const detectedLocalBusinessTypes =
    Array.from(
      allTypes.keys(),
    ).filter(
      (t) =>
        localBusinessTypes.has(
          t.toLowerCase(),
        ),
    )

  return {
    jsonLdOrMicrodataPresent:
      allTypes.size > 0,

    unparsableJsonLdFound:
      unparsableFound,

    localBusinessSchemaPresent:
      detectedLocalBusinessTypes.length >
      0,

    detectedLocalBusinessTypes,

    allDetectedTypes:
      Array.from(
        allTypes.entries(),
      ).map(
        ([type, urls]) => ({
          type,
          urls:
            Array.from(
              new Set(urls),
            ),
        }),
      ),
  }
}

function buildDuplicateEvidence(
  pages: PageAnalysis[],
) {
  const candidates =
    pages.filter(
      (p) =>
        p.fetchOk &&
        (
          p.pageType ===
            "service" ||
          p.pageType ===
            "location"
        ) &&
        p.shingles.length >
          0,
    )

  const comparisons: {
    a: string
    b: string
    similarity: number
    possibleDuplicate: boolean
  }[] = []

  for (
    let i = 0;
    i < candidates.length;
    i++
  ) {
    for (
      let j = i + 1;
      j < candidates.length;
      j++
    ) {
      const similarity =
        jaccardSimilarity(
          candidates[i].shingles,
          candidates[j].shingles,
        )

      if (
        similarity > 0.1
      ) {
        comparisons.push({
          a:
            candidates[i]
              .finalUrl,

          b:
            candidates[j]
              .finalUrl,

          similarity,

          possibleDuplicate:
            similarity >= 0.8,
        })
      }
    }
  }

  comparisons.sort(
    (a, b) =>
      b.similarity -
      a.similarity,
  )

  const fpGroups =
    new Map<
      string,
      string[]
    >()

  for (const p of pages) {
    if (
      !p.contentFingerprint ||
      !p.fetchOk
    ) {
      continue
    }

    if (
      !fpGroups.has(
        p.contentFingerprint,
      )
    ) {
      fpGroups.set(
        p.contentFingerprint,
        [],
      )
    }

    fpGroups
      .get(
        p.contentFingerprint,
      )!
      .push(
        p.finalUrl,
      )
  }

  const exactDuplicateGroups =
    Array.from(
      fpGroups.values(),
    ).filter(
      (urls) =>
        urls.length > 1,
    )

  return {
    comparedPageCount:
      candidates.length,

    possibleDuplicate:
      comparisons.some(
        (c) =>
          c.possibleDuplicate,
      ) ||
      exactDuplicateGroups.length >
        0,

    highestSimilarity:
      comparisons.length > 0
        ? comparisons[0]
            .similarity
        : null,

    pairwiseSimilarities:
      comparisons.slice(
        0,
        20,
      ),

    exactDuplicateGroups,
  }
}

function methodNotAllowed(
  request: NextRequest,
) {
  return NextResponse.json(
    {
      error:
        "Method not allowed. Use POST.",
    },
    {
      status: 405,
      headers: {
        ...corsHeaders(
          request,
        ),
        Allow:
          "POST, OPTIONS",
      },
    },
  )
}

export const GET =
  methodNotAllowed

export const PUT =
  methodNotAllowed

export const PATCH =
  methodNotAllowed

export const DELETE =
  methodNotAllowed

export const HEAD =
  methodNotAllowed