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

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape"
const FIRECRAWL_WAIT_MS = 1_000
const FIRECRAWL_TIMEOUT_MS = 12_000

type CrawlRequestBody = {
  website?: unknown
  businessName?: unknown
  service?: unknown
  location?: unknown
  maxPages?: unknown
  perPageTimeoutMs?: unknown
  concurrency?: unknown
}

type QueueItem = {
  url: string
  anchor: string
  priority: number
}

type RenderedFetchResult = {
  html: string
  finalUrl: string
  status: number
}

function normalizeWebsiteInput(value: unknown): string | null {
  if (!isNonEmptyString(value)) return null;

  let normalized = value.trim();

  // Remove accidental escaping
  normalized = normalized.replace(/\\/g, "");

  // Add protocol if missing
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = 'https://${normalized};'
  }

  try {
    const url = new URL(normalized);

    // Prefer apex domain rather than www.
    if (url.hostname.toLowerCase().startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
    }

    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
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

function needsRenderedFallback(
  analysis: PageAnalysis,
): boolean {
  return (
    analysis.fetchOk &&
    (
      analysis.wordCount < 80 ||
      (
        analysis.h1.length === 0 &&
        analysis.internalLinks.length === 0
      )
    )
  )
}

async function fetchRenderedHtml(
  url: string,
): Promise<RenderedFetchResult | null> {
  const apiKey = process.env.FIRECRAWL_API_KEY

  if (!isNonEmptyString(apiKey)) {
    return null
  }

  const controller = new AbortController()

  const timer = setTimeout(
    () => controller.abort(),
    FIRECRAWL_TIMEOUT_MS + 2_000,
  )

  try {
    const response = await fetch(
      FIRECRAWL_SCRAPE_URL,
      {
        method: "POST",
        headers: {
          Authorization: 'Bearer ${apiKey}',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url,
          formats: ["html"],
          onlyMainContent: false,
          waitFor: FIRECRAWL_WAIT_MS,
          timeout: FIRECRAWL_TIMEOUT_MS,
          blockAds: true,
          storeInCache: true,
          location: {
            country: "GB",
            languages: ["en-GB", "en"],
          },
        }),
        signal: controller.signal,
        cache: "no-store",
      },
    )

    if (!response.ok) {
      const detail = await response
        .text()
        .catch(() => "")

      console.error(
        "[SyncFlo] Firecrawl rendered fallback failed:",
        response.status,
        detail.slice(0, 500),
      )

      return null
    }

    const payload = (await response.json()) as {
      success?: boolean
      data?: {
        html?: unknown
        metadata?: {
          url?: unknown
          sourceURL?: unknown
          statusCode?: unknown
        }
      }
    }

    const html =
      typeof payload?.data?.html === "string"
        ? payload.data.html
        : null

    if (!payload.success || !html) {
      return null
    }

    const metadata = payload.data?.metadata

    const finalUrl =
      typeof metadata?.url === "string"
        ? metadata.url
        : typeof metadata?.sourceURL === "string"
          ? metadata.sourceURL
          : url

    const status =
      typeof metadata?.statusCode === "number"
        ? metadata.statusCode
        : 200

    return {
      html,
      finalUrl,
      status,
    }
  } catch (err) {
    const timedOut =
      err instanceof Error &&
      err.name === "AbortError"

    console.error(
      timedOut
        ? "[SyncFlo] Firecrawl rendered fallback timed out."
        : "[SyncFlo] Firecrawl rendered fallback request failed:",
      timedOut ? url : err,
    )

    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function OPTIONS(
  request: NextRequest,
) {
  return corsOptions(request)
}

export async function POST(
  request: NextRequest,
) {
  let body: CrawlRequestBody

  try {
    body =
      (await request.json()) as CrawlRequestBody
  } catch {
    return jsonError(
      request,
      "Invalid JSON body.",
      400,
    )
  }

  const website =
    normalizeWebsiteInput(body.website)

  const businessName =
    isNonEmptyString(body.businessName)
      ? body.businessName.trim()
      : null

  const service =
    isNonEmptyString(body.service)
      ? body.service.trim()
      : null

  const location =
    isNonEmptyString(body.location)
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
      'Missing or invalid required field(s): ${missing.join(", ")}.',
      400,
    )
  }

  const validatedWebsite =
    website as string

  const validatedBusinessName =
    businessName as string

  const validatedService =
    service as string

  const validatedLocation =
    location as string

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
    startUrl =
      await assertPublicUrl(validatedWebsite)
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

  const startedAt =
    new Date().toISOString()

  let rootHostname: string

  try {
    rootHostname =
      new URL(startUrl).hostname
  } catch {
    return jsonError(
      request,
      "The submitted website could not be validated.",
      400,
    )
  }

  const canonicalStart =
    canonicalizeUrl(startUrl) ?? startUrl

  const visited =
    new Set<string>([
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
      const result = await safeFetch(
        url,
        {
          timeoutMs:
            perPageTimeoutMs,
        },
      )

      if (!result.html) {
        return failedPage(
          url,
          result.finalUrl,
          result.status,
          result.ok,
          "Non-HTML or empty response.",
        )
      }

      let analysis =
        analyzePage({
          requestedUrl: url,
          finalUrl:
            result.finalUrl,
          status:
            result.status,
          ok:
            result.ok,
          html:
            result.html,
          isHomepage,
          rootHostname,
          businessName:
            validatedBusinessName,
          service:
            validatedService,
          location:
            validatedLocation,
        })

      if (
        needsRenderedFallback(
          analysis,
        )
      ) {
        const rendered =
          await fetchRenderedHtml(
            result.finalUrl || url,
          )

        if (rendered?.html) {
          const renderedAnalysis =
            analyzePage({
              requestedUrl: url,
              finalUrl:
                rendered.finalUrl,
              status:
                rendered.status,
              ok:
                rendered.status >= 200 &&
                rendered.status < 400,
              html:
                rendered.html,
              isHomepage,
              rootHostname,
              businessName:
                validatedBusinessName,
              service:
                validatedService,
              location:
                validatedLocation,
            })

          const rawEvidence =
            analysis.wordCount +
            analysis.internalLinks.length * 10 +
            analysis.h1.length * 20 +
            analysis.schemaTypes.length * 15

          const renderedEvidence =
            renderedAnalysis.wordCount +
            renderedAnalysis.internalLinks.length * 10 +
            renderedAnalysis.h1.length * 20 +
            renderedAnalysis.schemaTypes.length * 15

          if (
            renderedEvidence >
            rawEvidence
          ) {
            analysis =
              renderedAnalysis
          }
        }
      }

      if (analysis.fetchOk) {
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
    for (
      const link
      of analysis.internalLinks
    ) {
      const canon =
        canonicalizeUrl(link.url)

      if (!canon) continue
      if (visited.has(canon)) continue

      if (
        !isSameSite(
          canon,
          rootHostname,
        )
      ) {
        continue
      }

      if (
        !isCrawlableUrl(canon)
      ) {
        continue
      }

      visited.add(canon)

      queue.push({
        url: canon,
        anchor: link.anchor,
        priority:
          urlPriority(
            canon,
            link.anchor,
            validatedService,
            validatedLocation,
          ),
      })
    }
  }

  pagesAttempted++

  const homepage =
    await crawlOne(
      startUrl,
      true,
    )

  pages.push(homepage)

  if (
    pages.length <
    maxPages
  ) {
    enqueueLinks(homepage)
  }

  async function worker() {
    while (true) {
      if (
        pagesAttempted >=
        maxPages
      ) {
        return
      }

      if (
        queue.length === 0
      ) {
        if (
          activeWorkers > 0
        ) {
          await new Promise(
            (resolve) =>
              setTimeout(
                resolve,
                15,
              ),
          )

          continue
        }

        return
      }

      queue.sort(
        (a, b) =>
          b.priority -
          a.priority,
      )

      const item =
        queue.shift()

      if (!item) continue

      pagesAttempted++
      activeWorkers++

      try {
        const analysis =
          await crawlOne(
            item.url,
            false,
          )

        pages.push(
          analysis,
        )

        if (
          pages.length <
          maxPages
        ) {
          enqueueLinks(
            analysis,
          )
        }
      } finally {
        activeWorkers--
      }
    }
  }

  if (
    queue.length > 0 &&
    pages.length <
      maxPages
  ) {
    const workerCount =
      Math.min(
        concurrency,
        Math.max(
          1,
          queue.length,
        ),
      )

    await Promise.all(
      Array.from(
        {
          length:
            workerCount,
        },
        () => worker(),
      ),
    )
  }

  if (
    !homepage.fetchOk &&
    pagesSuccessfullyCrawled ===
      0
  ) {
    return NextResponse.json(
      {
        crawlStatus:
          "unavailable",

        error:
          "The website could not be crawled.",

        crawlMeta: {
          pagesAttempted,
          pagesSuccessfullyCrawled,
          startedAt,
          completedAt:
            new Date()
              .toISOString(),
        },
      },
      {
        status: 200,
        headers:
          corsHeaders(
            request,
          ),
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
    pagesSuccessfullyCrawled ===
    0
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
        website:
          startUrl,
        businessName:
          validatedBusinessName,
        service:
          validatedService,
        location:
          validatedLocation,
      },

      website: {
        submittedUrl:
          validatedWebsite,

        finalUrl:
          homepage.finalUrl,

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

        renderedFallbackConfigured:
          isNonEmptyString(
            process.env
              .FIRECRAWL_API_KEY,
          ),

        startedAt,
        completedAt,
      },
    },
    {
      headers:
        corsHeaders(
          request,
        ),
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
      finalUrl.startsWith(
        "https://",
      ),

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
    finalUrl:
      p.finalUrl,

    status:
      p.status,

    httpsActive:
      p.httpsActive,

    title:
      p.title,

    metaDescription:
      p.metaDescription,

    h1:
      p.h1,

    canonical:
      p.canonical,

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
    url:
      p.url,

    finalUrl:
      p.finalUrl,

    status:
      p.status,

    fetchOk:
      p.fetchOk,

    pageType:
      p.pageType,

    title:
      p.title,

    metaDescription:
      p.metaDescription,

    h1:
      p.h1,

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
          error:
            p.error,
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
        p.pageType ===
          "service" &&
        p.fetchOk,
    )

  const dedicated =
    servicePages.filter(
      (p) =>
        p.serviceInTitle ||
        p.serviceInH1 ||
        p.serviceMentionCount >=
          3,
    )

  const linkedUrls =
    new Set<string>()

  for (const p of pages) {
    for (
      const l
      of p.internalLinks
    ) {
      linkedUrls.add(
        l.url,
      )
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
      dedicated
        .filter(
          (p) =>
            linkedUrls.has(
              p.finalUrl,
            ),
        )
        .map(
          (p) =>
            p.finalUrl,
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
        (p) => p.finalUrl,
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
      pages
        .filter(
          (p) =>
            p.fetchOk &&
            p.serviceMentioned &&
            p.locationMentioned,
        )
        .map(
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
  const phoneNumbers =
    new Set<string>()

  const emailAddresses =
    new Set<string>()

  const postalAddresses =
    new Set<string>()

  let businessNameFoundOnSite =
    false

  let contactPageUrl:
    string | null = null

  for (const p of pages) {
    if (!p.fetchOk) {
      continue
    }

    if (
      p.businessNameMentioned
    ) {
      businessNameFoundOnSite =
        true
    }

    for (
      const phone
      of p.phoneNumbers
    ) {
      phoneNumbers.add(
        phone,
      )
    }

    for (
      const email
      of p.emailAddresses
    ) {
      emailAddresses.add(
        email,
      )
    }

    for (
      const address
      of p.postalAddresses
    ) {
      postalAddresses.add(
        address,
      )
    }

    if (
      !contactPageUrl &&
      p.pageType ===
        "contact"
    ) {
      contactPageUrl =
        p.finalUrl
    }
  }

  return {
    businessName,

    businessNameFoundOnSite,

    phoneNumbers:
      Array.from(
        phoneNumbers,
      ),

    emailAddresses:
      Array.from(
        emailAddresses,
      ),

    postalAddresses:
      Array.from(
        postalAddresses,
      ),

    contactPageUrl,

    distinctPhoneCount:
      phoneNumbers.size,

    distinctEmailCount:
      emailAddresses.size,
  }
}

function buildSchemaEvidence(
  pages: PageAnalysis[],
) {
  const allTypes =
    new Map<
      string,
      string
    >()

  let unparsableFound =
    false

  const localBusinessTypes =
    new Set([
      "localbusiness",
      "professionalservice",
      "homeandconstructionbusiness",
      "electrician",
      "plumber",
      "roofingcontractor",
      "hvacbusiness",
      "locksmith",
      "housepainter",
      "generalcontractor",
    ])

  for (const p of pages) {
    if (!p.fetchOk) {
      continue
    }

    for (
      const raw
      of p.schemaTypes
    ) {
      if (
        raw ===
        "_unparsable_jsonld_"
      ) {
        unparsableFound =
          true
        continue
      }

      const normalized =
        raw
          .trim()
          .toLowerCase()

      if (!normalized) {
        continue
      }

      if (
        !allTypes.has(
          normalized,
        )
      ) {
        allTypes.set(
          normalized,
          raw,
        )
      }
    }
  }

  const detectedLocalBusinessTypes =
    Array.from(
      allTypes.keys(),
    )
      .filter(
        (type) =>
          localBusinessTypes.has(
            type,
          ),
      )
      .map(
        (type) =>
          allTypes.get(
            type,
          ) as string,
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
        allTypes.values(),
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
        p.shingles.length >
          0,
    )

  const pairwiseSimilarities:
    Array<{
      urlA: string
      urlB: string
      similarity: number
    }> = []

  let highestSimilarity:
    number | null = null

  for (
    let i = 0;
    i <
    candidates.length;
    i++
  ) {
    for (
      let j = i + 1;
      j <
      candidates.length;
      j++
    ) {
      const similarity =
        jaccardSimilarity(
          candidates[i]
            .shingles,

          candidates[j]
            .shingles,
        )

      pairwiseSimilarities.push(
        {
          urlA:
            candidates[i]
              .finalUrl,

          urlB:
            candidates[j]
              .finalUrl,

          similarity,
        },
      )

      if (
        highestSimilarity ===
          null ||
        similarity >
          highestSimilarity
      ) {
        highestSimilarity =
          similarity
      }
    }
  }

  pairwiseSimilarities.sort(
    (a, b) =>
      b.similarity -
      a.similarity,
  )

  const fingerprintGroups =
    new Map<
      string,
      string[]
    >()

  for (const p of candidates) {
    if (
      !p.contentFingerprint
    ) {
      continue
    }

    const urls =
      fingerprintGroups.get(
        p.contentFingerprint,
      ) ?? []

    urls.push(
      p.finalUrl,
    )

    fingerprintGroups.set(
      p.contentFingerprint,
      urls,
    )
  }

  const exactDuplicateGroups =
    Array.from(
      fingerprintGroups.values(),
    ).filter(
      (group) =>
        group.length > 1,
    )

  return {
    comparedPageCount:
      candidates.length,

    possibleDuplicate:
      exactDuplicateGroups.length >
        0 ||
      (
        highestSimilarity !==
          null &&
        highestSimilarity >=
          0.85
      ),

    highestSimilarity,

    pairwiseSimilarities:
      pairwiseSimilarities.slice(
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
