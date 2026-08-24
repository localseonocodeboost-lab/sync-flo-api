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

type RenderedFetchResult = {
  html: string
  finalUrl: string
  status: number
}

type QueueItem = {
  url: string
  anchor: string
  priority: number
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function normalizeWebsiteInput(value: unknown): string | null {
  if (!isNonEmptyString(value)) return null

  let normalized = value.trim()

  normalized = normalized.replace(/\\/g, "")

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

function needsRenderedFallback(analysis: PageAnalysis): boolean {
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
    const response = await fetch(FIRECRAWL_SCRAPE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
    })

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
    function failedPage(
    requestedUrl: string,
    finalUrl: string,
    status: number,
    ok: boolean,
    reason: string,
  ): PageAnalysis {
    return {
      requestedUrl,
      finalUrl,
      status,
      fetchOk: ok,
      failureReason: reason,
      pageType: "other",
      title: null,
      metaDescription: null,
      h1: [],
      canonical: null,
      metaRobots: null,
      indexable: false,
      wordCount: 0,
      visibleText: "",
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
      schemaTypes: [],
      unparsableJsonLdFound: false,
      internalLinks: [],
      externalLinks: [],
      contentFingerprint: "",
      contentTokens: [],
    }
  }

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

      let analysis = analyzePage({
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

      /*
       * React / AI Studio sites can return a tiny HTML shell to a
       * normal server-side request while JavaScript renders the actual
       * page in the browser.
       *
       * When the first pass looks suspiciously thin, Firecrawl is used
       * to obtain rendered HTML. Ordinary HTML sites continue to use
       * the faster normal crawler.
       */
      if (needsRenderedFallback(analysis)) {
        const rendered = await fetchRenderedHtml(
          result.finalUrl || url,
        )

        if (rendered?.html) {
          const renderedAnalysis = analyzePage({
            requestedUrl: url,
            finalUrl: rendered.finalUrl,
            status: rendered.status,
            ok:
              rendered.status >= 200 &&
              rendered.status < 400,
            html: rendered.html,
            isHomepage,
            rootHostname,
            businessName: validatedBusinessName,
            service: validatedService,
            location: validatedLocation,
          })

          /*
           * Compare the amount of useful evidence found by each method.
           * We only replace the normal crawl when rendered HTML actually
           * gives us a richer representation of the page.
           */
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

          if (renderedEvidence > rawEvidence) {
            analysis = renderedAnalysis
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
    for (const link of analysis.internalLinks) {
      if (!link.url) continue

      const canonical =
        canonicalizeUrl(link.url)

      if (!canonical) continue

      if (visited.has(canonical)) continue

      if (!isSameSite(canonical, rootHostname)) {
        continue
      }

      if (!isCrawlableUrl(canonical)) {
        continue
      }

      visited.add(canonical)

      queue.push({
        url: canonical,
        anchor: link.anchor ?? "",
        priority: urlPriority(
          canonical,
          link.anchor ?? "",
          validatedService,
          validatedLocation,
        ),
      })
    }

    queue.sort(
      (a, b) => b.priority - a.priority,
    )
  }

  /*
   * Crawl the homepage first.
   *
   * This is important because its rendered navigation gives us the
   * internal URLs used to populate the rest of the crawl queue.
   */
  pagesAttempted++

  const homepage = await crawlOne(
    canonicalStart,
    true,
  )

  pages.push(homepage)
  enqueueLinks(homepage)

  /*
   * Crawl discovered pages with a small concurrency limit.
   * We stop once maxPages has been reached.
   */
  async function worker() {
    activeWorkers++

    try {
      while (
        queue.length > 0 &&
        pages.length < maxPages
      ) {
        const next = queue.shift()

        if (!next) break

        if (pages.length >= maxPages) {
          break
        }

        pagesAttempted++

        const analysis = await crawlOne(
          next.url,
          false,
        )

        pages.push(analysis)
        enqueueLinks(analysis)
      }
    } finally {
      activeWorkers--
    }
  }

  if (
    queue.length > 0 &&
    pages.length < maxPages
  ) {
    const workerCount = Math.min(
      concurrency,
      queue.length,
      maxPages - pages.length,
    )

    await Promise.all(
      Array.from(
        { length: workerCount },
        () => worker(),
      ),
    )
  }

  /*
   * Sort so the homepage stays first and the remaining pages are
   * deterministic.
   */
  const homepageFinalUrl =
    homepage.finalUrl || canonicalStart

  const remainingPages = pages
    .filter((page) => page !== homepage)
    .sort((a, b) =>
      a.finalUrl.localeCompare(b.finalUrl),
    )

  const orderedPages = [
    homepage,
    ...remainingPages,
  ]

  /*
   * Build site-wide evidence.
   */
  const successfulPages =
    orderedPages.filter(
      (page) => page.fetchOk,
    )

  const servicePages =
    successfulPages.filter(
      (page) =>
        page.serviceMentioned &&
        page.pageType !== "homepage",
    )

  const dedicatedServicePages =
    servicePages.filter(
      (page) =>
        page.serviceInTitle ||
        page.serviceInH1 ||
        page.pageType === "service",
    )

  const locationPages =
    successfulPages.filter(
      (page) =>
        page.locationMentioned &&
        page.pageType !== "homepage",
    )

  const locationInTitleOrH1Pages =
    successfulPages.filter(
      (page) =>
        page.locationInTitle ||
        page.locationInH1,
    )

  const serviceAndLocationPages =
    successfulPages.filter(
      (page) =>
        page.serviceMentioned &&
        page.locationMentioned,
    )

  const allPhoneNumbers = Array.from(
    new Set(
      successfulPages.flatMap(
        (page) => page.phoneNumbers,
      ),
    ),
  )

  const allEmailAddresses = Array.from(
    new Set(
      successfulPages.flatMap(
        (page) => page.emailAddresses,
      ),
    ),
  )

  const allPostalAddresses = Array.from(
    new Set(
      successfulPages.flatMap(
        (page) => page.postalAddresses,
      ),
    ),
  )

  const allSchemaTypes = Array.from(
    new Set(
      successfulPages.flatMap(
        (page) => page.schemaTypes,
      ),
    ),
  )

  const localBusinessTypes =
    allSchemaTypes.filter((type) => {
      const normalized =
        type.toLowerCase()

      return (
        normalized.includes("localbusiness") ||
        normalized.includes("professionalservice") ||
        normalized.includes("homeandconstructionbusiness") ||
        normalized.includes("plumber") ||
        normalized.includes("electrician") ||
        normalized.includes("roofingcontractor") ||
        normalized.includes("hvacbusiness")
      )
    })

  const contactPage =
    successfulPages.find((page) => {
      try {
        const pathname =
          new URL(page.finalUrl)
            .pathname
            .toLowerCase()

        return (
          pathname.includes("/contact") ||
          pathname.includes("/get-in-touch")
        )
      } catch {
        return false
      }
    }) ?? null
    /*
   * Work out which important service pages are linked internally.
   */
  const internallyLinkedUrls = new Set(
    successfulPages.flatMap(
      (page) =>
        page.internalLinks
          .map((link) =>
            canonicalizeUrl(link.url),
          )
          .filter(
            (url): url is string =>
              typeof url === "string",
          ),
    ),
  )

  const servicePagesInternallyLinked =
    dedicatedServicePages
      .filter((page) => {
        const canonical =
          canonicalizeUrl(page.finalUrl)

        return (
          canonical !== null &&
          internallyLinkedUrls.has(canonical)
        )
      })
      .map((page) => page.finalUrl)

  /*
   * Duplicate-content analysis.
   *
   * Only compare successfully crawled pages that contain enough
   * meaningful text to make the comparison useful.
   */
  const duplicateCandidates =
    successfulPages.filter(
      (page) =>
        page.contentTokens.length >= 20,
    )

  const pairwiseSimilarities: Array<{
    urlA: string
    urlB: string
    similarity: number
  }> = []

  let highestSimilarity: number | null =
    null

  for (
    let i = 0;
    i < duplicateCandidates.length;
    i++
  ) {
    for (
      let j = i + 1;
      j < duplicateCandidates.length;
      j++
    ) {
      const a = duplicateCandidates[i]
      const b = duplicateCandidates[j]

      const similarity =
        jaccardSimilarity(
          a.contentTokens,
          b.contentTokens,
        )

      pairwiseSimilarities.push({
        urlA: a.finalUrl,
        urlB: b.finalUrl,
        similarity:
          Math.round(similarity * 1000) /
          1000,
      })

      if (
        highestSimilarity === null ||
        similarity > highestSimilarity
      ) {
        highestSimilarity = similarity
      }
    }
  }

  pairwiseSimilarities.sort(
    (a, b) =>
      b.similarity - a.similarity,
  )

  /*
   * Exact duplicates use the deterministic content fingerprint
   * generated by analyzePage().
   */
  const fingerprintGroups =
    new Map<string, string[]>()

  for (const page of successfulPages) {
    if (!page.contentFingerprint) {
      continue
    }

    const existing =
      fingerprintGroups.get(
        page.contentFingerprint,
      ) ?? []

    existing.push(page.finalUrl)

    fingerprintGroups.set(
      page.contentFingerprint,
      existing,
    )
  }

  const exactDuplicateGroups =
    Array.from(
      fingerprintGroups.values(),
    ).filter(
      (urls) => urls.length > 1,
    )

  const possibleDuplicate =
    exactDuplicateGroups.length > 0 ||
    (
      highestSimilarity !== null &&
      highestSimilarity >= 0.85
    )

  /*
   * Homepage evidence.
   */
  const homepageEvidence = {
    finalUrl:
      homepage.finalUrl ||
      homepageFinalUrl,

    status:
      homepage.status,

    httpsActive:
      (
        homepage.finalUrl ||
        homepageFinalUrl
      )
        .toLowerCase()
        .startsWith("https://"),

    title:
      homepage.title,

    metaDescription:
      homepage.metaDescription,

    h1:
      homepage.h1,

    canonical:
      homepage.canonical,

    metaRobots:
      homepage.metaRobots,

    indexable:
      homepage.indexable,

    businessNameMentioned:
      homepage.businessNameMentioned,

    serviceMentioned:
      homepage.serviceMentioned,

    serviceInTitle:
      homepage.serviceInTitle,

    serviceInH1:
      homepage.serviceInH1,

    locationMentioned:
      homepage.locationMentioned,

    locationInTitle:
      homepage.locationInTitle,

    locationInH1:
      homepage.locationInH1,

    phoneNumbers:
      homepage.phoneNumbers,

    emailAddresses:
      homepage.emailAddresses,

    postalAddresses:
      homepage.postalAddresses,

    schemaTypes:
      homepage.schemaTypes,

    internalLinkCount:
      homepage.internalLinks.length,

    externalLinks:
      homepage.externalLinks,

    wordCount:
      homepage.wordCount,
  }

  /*
   * Compact page representation returned to the frontend.
   *
   * visibleText and contentTokens are deliberately excluded from the
   * public response because they can be large and are only required
   * internally for deterministic analysis.
   */
  const publicPages =
    orderedPages.map((page) => ({
      url:
        page.requestedUrl,

      finalUrl:
        page.finalUrl,

      status:
        page.status,

      fetchOk:
        page.fetchOk,

      pageType:
        page.pageType,

      title:
        page.title,

      metaDescription:
        page.metaDescription,

      h1:
        page.h1,

      canonical:
        page.canonical,

      metaRobots:
        page.metaRobots,

      indexable:
        page.indexable,

      wordCount:
        page.wordCount,

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
    }))

  /*
   * Determine whether the submitted business name was found anywhere
   * on the site.
   */
  const businessNameFoundOnSite =
    successfulPages.some(
      (page) =>
        page.businessNameMentioned,
    )

  /*
   * A service page is considered prominent when the submitted service
   * appears in its title or H1.
   */
  const serviceProminentPages =
    successfulPages
      .filter(
        (page) =>
          page.serviceInTitle ||
          page.serviceInH1,
      )
      .map((page) => ({
        url: page.finalUrl,
        inTitle:
          page.serviceInTitle,
        inH1:
          page.serviceInH1,
      }))

  const locationTitleOrH1Evidence =
    locationInTitleOrH1Pages.map(
      (page) => ({
        url: page.finalUrl,
        inTitle:
          page.locationInTitle,
        inH1:
          page.locationInH1,
      }),
    )

  const serviceLocationEvidence =
    serviceAndLocationPages.map(
      (page) => ({
        url: page.finalUrl,
        serviceMentionCount:
          page.serviceMentionCount,
        locationMentionCount:
          page.locationMentionCount,
      }),
    )

  /*
   * Whether any JSON-LD or microdata evidence was found.
   */
  const schemaPresent =
    allSchemaTypes.length > 0

  const unparsableJsonLdFound =
    successfulPages.some(
      (page) =>
        page.unparsableJsonLdFound,
    )

  /*
   * Build the final deterministic response.
   */
  const completedAt =
    new Date().toISOString()

  const responseBody = {
    crawlStatus: "success",

    query: {
      website: validatedWebsite,
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
        homepage.finalUrl ||
        homepageFinalUrl,

      rootHostname,

      httpsActive:
        (
          homepage.finalUrl ||
          homepageFinalUrl
        )
          .toLowerCase()
          .startsWith("https://"),

      reachable:
        homepage.fetchOk,
    },

    homepage:
      homepageEvidence,

    pages:
      publicPages,

    serviceEvidence: {
      submittedService:
        validatedService,

      servicePageCount:
        servicePages.length,

      servicePageUrls:
        servicePages.map(
          (page) => page.finalUrl,
        ),

      dedicatedServicePageExists:
        dedicatedServicePages.length > 0,

      dedicatedServicePageUrls:
        dedicatedServicePages.map(
          (page) => page.finalUrl,
        ),

      serviceProminentPages,

      servicePagesInternallyLinked,
          locationEvidence: {
      submittedLocation:
        validatedLocation,

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
          (page) => page.finalUrl,
        ),

      locationInTitleOrH1Pages:
        locationTitleOrH1Evidence,

      serviceAndLocationPages:
        serviceLocationEvidence,
    },

    contactEvidence: {
      businessName:
        validatedBusinessName,

      businessNameFoundOnSite,

      phoneNumbers:
        allPhoneNumbers.slice(0, 15),

      emailAddresses:
        allEmailAddresses.slice(0, 15),

      postalAddresses:
        allPostalAddresses.slice(0, 15),

      contactPageUrl:
        contactPage
          ? contactPage.finalUrl
          : null,

      distinctPhoneCount:
        allPhoneNumbers.length,

      distinctEmailCount:
        allEmailAddresses.length,
    },

    schemaEvidence: {
      jsonLdOrMicrodataPresent:
        schemaPresent,

      unparsableJsonLdFound,

      localBusinessSchemaPresent:
        localBusinessTypes.length > 0,

      detectedLocalBusinessTypes:
        localBusinessTypes,

      allDetectedTypes:
        allSchemaTypes,
    },

    duplicateEvidence: {
      comparedPageCount:
        duplicateCandidates.length,

      possibleDuplicate,

      highestSimilarity:
        highestSimilarity === null
          ? null
          : Math.round(
              highestSimilarity * 1000,
            ) / 1000,

      pairwiseSimilarities:
        pairwiseSimilarities.slice(
          0,
          20,
        ),

      exactDuplicateGroups,
    },

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
          process.env.FIRECRAWL_API_KEY,
        ),

      startedAt,
      completedAt,
    },
  }:
  return NextResponse.json(
    responseBody,
    {
      headers:
        corsHeaders(request),
    },
  )
}

/*
 * Reject unsupported methods explicitly.
 */
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
        ...corsHeaders(request),
        Allow: "POST, OPTIONS",
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
    },
