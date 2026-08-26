import { type NextRequest, NextResponse } from "next/server"
import { corsHeaders, corsJson, corsOptions } from "../../../lib/cors"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const PLACES_TEXT_SEARCH_URL =
  "https://places.googleapis.com/v1/places:searchText"

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.primaryType",
  "places.types",
  "places.location",
].join(",")

type PlacesRequestBody = {
  businessName?: unknown
  service?: unknown
  location?: unknown
}

type CleanPlace = {
  placeId: string | null
  name: string | null
  formattedAddress: string | null
  websiteUri: string | null
  rating: number | null
  userRatingCount: number | null
  primaryType: string | null
  types: string[]
  latitude: number | null
  longitude: number | null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function jsonError(
  request: NextRequest,
  message: string,
  status: number,
  details?: unknown,
) {
  return corsJson(
    request,
    {
      error: message,
      ...(details ? { details } : {}),
    },
    status,
  )
}

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request)
}

async function searchGooglePlaces(
  apiKey: string,
  textQuery: string,
  maxResultCount: number,
): Promise<CleanPlace[]> {
  let googleResponse: Response

  try {
    googleResponse = await fetch(PLACES_TEXT_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery,
        maxResultCount,
        languageCode: "en",
        regionCode: "GB",
      }),
      cache: "no-store",
    })
  } catch (err) {
    console.error(
      `[SyncFlo] Failed to reach Google Places API for query "${textQuery}":`,
      err,
    )
    throw new Error("Failed to reach the places provider.")
  }

  if (!googleResponse.ok) {
    let upstreamDetail: unknown

    try {
      upstreamDetail = await googleResponse.json()
    } catch {
      upstreamDetail = await googleResponse.text().catch(() => null)
    }

    console.error(
      `[SyncFlo] Google Places API error for query "${textQuery}":`,
      googleResponse.status,
      upstreamDetail,
    )

    throw new Error("Places provider returned an error.")
  }

  let data: { places?: unknown[] }

  try {
    data = (await googleResponse.json()) as {
      places?: unknown[]
    }
  } catch {
    throw new Error(
      "Received an invalid response from the places provider.",
    )
  }

  const rawPlaces = Array.isArray(data.places)
    ? data.places
    : []

  return rawPlaces.map((raw) => {
    const p = (raw ?? {}) as Record<string, any>

    return {
      placeId:
        typeof p.id === "string"
          ? p.id
          : null,

      name:
        typeof p?.displayName?.text === "string"
          ? p.displayName.text
          : null,

      formattedAddress:
        typeof p.formattedAddress === "string"
          ? p.formattedAddress
          : null,

      websiteUri:
        typeof p.websiteUri === "string"
          ? p.websiteUri
          : null,

      rating:
        typeof p.rating === "number"
          ? p.rating
          : null,

      userRatingCount:
        typeof p.userRatingCount === "number"
          ? p.userRatingCount
          : null,

      primaryType:
        typeof p.primaryType === "string"
          ? p.primaryType
          : null,

      types: Array.isArray(p.types)
        ? p.types.filter(
            (t: unknown): t is string =>
              typeof t === "string",
          )
        : [],

      latitude:
        typeof p?.location?.latitude === "number"
          ? p.location.latitude
          : null,

      longitude:
        typeof p?.location?.longitude === "number"
          ? p.location.longitude
          : null,
    }
  })
}

function dedupePlaces(places: CleanPlace[]): CleanPlace[] {
  const seen = new Set<string>()
  const deduped: CleanPlace[] = []

  for (const place of places) {
    const key =
      place.placeId ??
      `${place.name ?? ""}|${place.formattedAddress ?? ""}`

    if (seen.has(key)) continue

    seen.add(key)
    deduped.push(place)
  }

  return deduped
}

export async function POST(request: NextRequest) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY

  if (!isNonEmptyString(apiKey)) {
    console.error(
      "[SyncFlo] GOOGLE_PLACES_API_KEY is not configured on the server.",
    )
    return jsonError(request, "Server configuration error.", 500)
  }

  let body: PlacesRequestBody

  try {
    body = (await request.json()) as PlacesRequestBody
  } catch {
    return jsonError(request, "Invalid JSON body.", 400)
  }

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

  /*
   * Query 1: identity search.
   * Purpose: reliably find the submitted business.
   *
   * Example:
   *   "Sync Flo web design hull"
   */
  const identityQuery =
    `${businessName} ${service} ${location}`
      .replace(/\s+/g, " ")
      .trim()

  /*
   * Query 2: competitor discovery.
   * IMPORTANT: intentionally excludes the business name.
   *
   * Example:
   *   "web design hull"
   *
   * This is what gives the frontend genuine local competitor
   * candidates instead of returning only the submitted business.
   */
  const competitorQuery =
    `${service} ${location}`
      .replace(/\s+/g, " ")
      .trim()

  let identityPlaces: CleanPlace[]
  let competitorPlaces: CleanPlace[]

  try {
    ;[identityPlaces, competitorPlaces] = await Promise.all([
      searchGooglePlaces(apiKey, identityQuery, 5),
      searchGooglePlaces(apiKey, competitorQuery, 10),
    ])
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Places provider returned an error."

    return jsonError(
      request,
      message,
      502,
    )
  }

  /*
   * Put identity results first so the existing frontend matcher sees
   * the submitted business early, then append competitor candidates.
   * De-dupe by Google Place ID so the submitted business does not appear twice.
   */
  const places = dedupePlaces([
    ...identityPlaces,
    ...competitorPlaces,
  ])

  return corsJson(request, {
    query: {
      businessName,
      service,
      location,
      textQuery: identityQuery,
      identityQuery,
      competitorQuery,
    },
    resultCount: places.length,
    identityResultCount: identityPlaces.length,
    competitorResultCount: competitorPlaces.length,
    places,
  })
}

function methodNotAllowed(request: NextRequest) {
  return NextResponse.json(
    {
      error: "Method not allowed. Use POST.",
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

export const GET = methodNotAllowed
export const PUT = methodNotAllowed
export const PATCH = methodNotAllowed
export const DELETE = methodNotAllowed
export const HEAD = methodNotAllowed
