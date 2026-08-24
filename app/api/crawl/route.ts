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
  type PageType,
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

  return Math.min(max, Math.max(min, Math.floor(n)))
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
    return jsonError(request, "Invalid JSON body.", 400)
  }

  const website = isNonEmptyString(body.website)
    ? body.website.trim()
    : null

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
      Missing or invalid required field(s): ${missing.join(", ")}.,
      400,
    )
  }

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
    startUrl = await assertPublicUrl(website as string)
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

  const visited = new Set<string>([canonicalStart])
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
        businessName: businessName as string,
        service: service as string,
        location: location as string,
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

  function enqueueLinks(analysis: PageAnalysis) {
    for (const link of analysis.internalLinks) {
      const canon = canonicalizeUrl(link.url)

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
          service as string,
          location as string,
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

      if (!item) {
        continue
      }

      pagesAttempted++
      activeWorkers++

      try {
        const analysis = await crawlOne(
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
        error: "The website could not be crawled.",
        crawlMeta: {
          pagesAttempted,
          pagesSuccessfullyCrawled,
          startedAt,
          completedAt: new Date().toISOString(),
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
      service as string,
    )

  const locationEvidence =
    buildLocationEvidence(
      homepage,
      pages,
      location as string,
    )

  const contactEvidence =
    buildContactEvidence(
      pages,
      businessName as string,
    )

  const schemaEvidence =
    buildSchemaEvidence(pages)

  const duplicateEvidence =
    buildDuplicateEvidence(pages)

  const completedAt =
    new Date().toISOString()

  const crawlStatus =
    pagesSuccessfullyCrawled === 0
      ? "unavailable"
      : pages.some(
            (page) =>
              !page.fetchOk ||
              page.error,
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
        httpsActive: homepage.httpsActive,
        reachable: homepage.fetchOk,
      },

      homepage:
        toHomepageEvidence(homepage),

      pages:
        pages.map(toPageEvidence),

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
        maxPagesCeiling: MAX_PAGES,
        startedAt,
        completedAt,
      },
    },
    {
      headers: corsHeaders(request),
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
  page: PageAnalysis,
) {
  return {
    finalUrl: page.finalUrl,
    status: page.status,
    httpsActive: page.httpsActive,
    title: page.title,
    metaDescription:
      page.metaDescription,
    h1: page.h1,
    canonical: page.canonical,
    metaRobots: page.metaRobots,
    indexable: page.indexable,
    businessNameMentioned:
      page.businessNameMentioned,
    serviceMentioned:
      page.serviceMentioned,
    serviceInTitle:
      page.serviceInTitle,
    serviceInH1:
      page.serviceInH1,
    locationMentioned:
      page.locationMentioned,
    locationInTitle:
      page.locationInTitle,
    locationInH1:
      page.locationInH1,
    phoneNumbers:
      page.phoneNumbers,
    emailAddresses:
      page.emailAddresses,
    postalAddresses:
      page.postalAddresses,
    schemaTypes:
      page.schemaTypes,
    internalLinkCount:
      page.internalLinks.length,
    externalLinks:
      page.externalLinks,
    wordCount: page.wordCount,
  }
}

function toPageEvidence(
  page: PageAnalysis,
) {
  return {
    url: page.url,
    finalUrl: page.finalUrl,
    status: page.status,
    fetchOk: page.fetchOk,
    pageType: page.pageType,
    title: page.title,
    metaDescription:
      page.metaDescription,
    h1: page.h1,
    canonical: page.canonical,
    metaRobots:
      page.metaRobots,
    indexable: page.indexable,
    wordCount: page.wordCount,
    serviceMentioned:
      page.serviceMentioned,
    serviceMentionCount:
      page.serviceMentionCount,
    serviceInTitle:
      page.serviceInTitle,
    serviceInH1:
      page.serviceInH1,
    locationMentioned:
      page.locationMentioned,
    locationMentionCount:
      page.locationMentionCount,
    locationInTitle:
      page.locationInTitle,
    locationInH1:
      page.locationInH1,
    internalLinkCount:
      page.internalLinks.length,
    schemaTypes:
      page.schemaTypes,
    contentFingerprint:
      page.contentFingerprint,

    ...(page.error
      ? {
          error: page.error,
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
      (page) =>
        page.pageType === "service" &&
        page.fetchOk,
    )

  const dedicated =
    servicePages.filter(
      (page) =>
        page.serviceInTitle ||
        page.serviceInH1 ||
        page.serviceMentionCount >= 3,
    )

  const linkedUrls =
    new Set<string>()

  for (const page of pages) {
    for (const link of page.internalLinks) {
      linkedUrls.add(link.url)
    }
  }

  return {
    submittedService: service,

    servicePageCount:
      servicePages.length,

    servicePageUrls:
      servicePages.map(
        (page) =>
          page.finalUrl,
      ),

    dedicatedServicePageExists:
      dedicated.length > 0,

    dedicatedServicePageUrls:
      dedicated.map(
        (page) =>
          page.finalUrl,
      ),

    serviceProminentPages:
      pages
        .filter(
          (page) =>
            page.fetchOk &&
            (
              page.serviceInTitle ||
              page.serviceInH1
            ),
        )
        .map(
          (page) => ({
            url:
              page.finalUrl,

            inTitle:
              page.serviceInTitle,

            inH1:
              page.serviceInH1,
          }),
        ),

    servicePagesInternallyLinked:
      servicePages.map(
        (page) => ({
          url:
            page.finalUrl,

          internallyLinked:
            linkedUrls.has(
              canonicalizeUrl(
                page.finalUrl,
              ) ??
                page.finalUrl,
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
      (page) =>
        page.pageType ===
          "location" &&
        page.fetchOk,
    )

  const servicePlusLocation =
    pages.filter(
      (page) =>
        page.fetchOk &&
        page.serviceMentioned &&
        page.locationMentioned,
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
        (page) =>
          page.finalUrl,
      ),

    locationInTitleOrH1Pages:
      pages
        .filter(
          (page) =>
            page.fetchOk &&
            (
              page.locationInTitle ||
              page.locationInH1
            ),
        )
        .map(
          (page) => ({
            url:
              page.finalUrl,

            inTitle:
              page.locationInTitle,

            inH1:
              page.locationInH1,
          }),
        ),

    serviceAndLocationPages:
      servicePlusLocation.map(
        (page) => ({
          url:
            page.finalUrl,

          serviceMentionCount:
            page.serviceMentionCount,

          locationMentionCount:
            page.locationMentionCount,
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

  for (const page of pages) {
    for (
      const phone of
        page.phoneNumbers
    ) {
      phones.add(phone)
    }

    for (
      const email of
        page.emailAddresses
    ) {
      emails.add(email)
    }

    for (
      const address of
        page.postalAddresses
    ) {
      addresses.add(address)
    }
  }

  const contactPage =
    pages.find(
      (page) =>
        page.pageType ===
          "contact" &&
        page.fetchOk,
    )

  return {
    businessName,

    businessNameFoundOnSite:
      pages.some(
        (page) =>
          page.businessNameMentioned,
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

  for (const page of pages) {
    for (
      const type of
        page.schemaTypes
    ) {
      if (
        type ===
        "_unparsable_jsonld_"
      ) {
        unparsableFound =
          true

        continue
      }

      if (
        !allTypes.has(type)
      ) {
        allTypes.set(
          type,
          [],
        )
      }

      allTypes
        .get(type)!
        .push(
          page.finalUrl,
        )
    }
  }

  const detectedLocalBusinessTypes =
    Array.from(
      allTypes.keys(),
    ).filter(
      (type) =>
        localBusinessTypes.has(
          type.toLowerCase(),
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
      (page) =>
        page.fetchOk &&
        (
          page.pageType ===
            "service" ||
          page.pageType ===
            "location"
        ) &&
        page.shingles.length >
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

  const fingerprintGroups =
    new Map<
      string,
      string[]
    >()

  for (const page of pages) {
    if (
      !page.contentFingerprint ||
      !page.fetchOk
    ) {
      continue
    }

    if (
      !fingerprintGroups.has(
        page.contentFingerprint,
      )
    ) {
      fingerprintGroups.set(
        page.contentFingerprint,
        [],
      )
    }

    fingerprintGroups
      .get(
        page.contentFingerprint,
      )!
      .push(
        page.finalUrl,
      )
  }

  const exactDuplicateGroups =
    Array.from(
      fingerprintGroups.values(),
    ).filter(
      (urls) =>
        urls.length > 1,
    )

  return {
    comparedPageCount:
      candidates.length,

    possibleDuplicate:
      comparisons.some(
        (comparison) =>
          comparison.possibleDuplicate,
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
