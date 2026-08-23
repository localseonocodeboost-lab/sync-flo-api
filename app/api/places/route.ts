import { type NextRequest, NextResponse } from "next/server"

// Ensure this route always runs on the server and is never statically cached.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"

// The exact fields we request from Google Places API (New).
// Keeping this tight avoids over-fetching and controls billing SKU tier.
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

function jsonError(message: string, status: number, details?: unknown) {
  return NextResponse.json({ error: message, ...(details ? { details } : {}) }, { status })
}

export async function POST(request: NextRequest) {
  // 1. Read and validate the API key from a server-side env var only.
  const apiKey = process.env.GOOGLE_PLACES_API_KEY
  if (!isNonEmptyString(apiKey)) {
    // Never leak whether/why the key is missing beyond a generic message.
    console.error("[v0] GOOGLE_PLACES_API_KEY is not configured on the server.")
    return jsonError("Server configuration error.", 500)
  }

  // 2. Parse JSON body safely.
  let body: PlacesRequestBody
  try {
    body = (await request.json()) as PlacesRequestBody
  } catch {
    return jsonError("Invalid JSON body.", 400)
  }

  // 3. Validate required inputs.
  const businessName = isNonEmptyString(body.businessName) ? body.businessName.trim() : null
  const service = isNonEmptyString(body.service) ? body.service.trim() : null
  const location = isNonEmptyString(body.location) ? body.location.trim() : null

  const missing: string[] = []
  if (!businessName) missing.push("businessName")
  if (!service) missing.push("service")
  if (!location) missing.push("location")

  if (missing.length > 0) {
    return jsonError(`Missing or invalid required field(s): ${missing.join(", ")}.`, 400)
  }

  // 4. Build the text search query.
  const textQuery = `${businessName} ${service} ${location}`.replace(/\s+/g, " ").trim()

  // 5. Call Google Places API (New) Text Search.
  let googleResponse: Response
  try {
    googleResponse = await fetch(PLACES_TEXT_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({ textQuery }),
      // Never cache upstream responses that depend on user input.
      cache: "no-store",
    })
  } catch (err) {
    console.error("[v0] Failed to reach Google Places API:", err)
    return jsonError("Failed to reach the places provider.", 502)
  }

  if (!googleResponse.ok) {
    // Log full upstream detail server-side, but return a sanitized message.
    let upstreamDetail: unknown
    try {
      upstreamDetail = await googleResponse.json()
    } catch {
      upstreamDetail = await googleResponse.text().catch(() => null)
    }
    console.error("[v0] Google Places API error:", googleResponse.status, upstreamDetail)
    return jsonError("Places provider returned an error.", 502)
  }

  let data: { places?: unknown[] }
  try {
    data = (await googleResponse.json()) as { places?: unknown[] }
  } catch {
    return jsonError("Received an invalid response from the places provider.", 502)
  }

  // 6. Normalize into clean, structured JSON.
  const rawPlaces = Array.isArray(data.places) ? data.places : []
  const places: CleanPlace[] = rawPlaces.map((raw) => {
    const p = (raw ?? {}) as Record<string, any>
    return {
      placeId: typeof p.id === "string" ? p.id : null,
      name: typeof p?.displayName?.text === "string" ? p.displayName.text : null,
      formattedAddress: typeof p.formattedAddress === "string" ? p.formattedAddress : null,
      websiteUri: typeof p.websiteUri === "string" ? p.websiteUri : null,
      rating: typeof p.rating === "number" ? p.rating : null,
      userRatingCount: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
      primaryType: typeof p.primaryType === "string" ? p.primaryType : null,
      types: Array.isArray(p.types) ? p.types.filter((t: unknown): t is string => typeof t === "string") : [],
      latitude: typeof p?.location?.latitude === "number" ? p.location.latitude : null,
      longitude: typeof p?.location?.longitude === "number" ? p.location.longitude : null,
    }
  })

  return NextResponse.json({
    query: {
      businessName,
      service,
      location,
      textQuery,
    },
    resultCount: places.length,
    places,
  })
}

// 7. Explicitly reject non-POST methods.
function methodNotAllowed() {
  return NextResponse.json(
    { error: "Method not allowed. Use POST." },
    { status: 405, headers: { Allow: "POST" } },
  )
}

export const GET = methodNotAllowed
export const PUT = methodNotAllowed
export const PATCH = methodNotAllowed
export const DELETE = methodNotAllowed
export const HEAD = methodNotAllowed
