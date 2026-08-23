import { NextResponse, type NextRequest } from "next/server"

export const ALLOWED_ORIGINS = new Set([
  "https://syncflo.co.uk",
  "https://www.syncflo.co.uk",
])

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin")

  const headers: Record<string, string> = {
    Vary: "Origin",
  }

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    headers["Access-Control-Allow-Headers"] = "Content-Type"
    headers["Access-Control-Max-Age"] = "86400"
  }

  return headers
}

export function corsJson(
  request: Request,
  body: unknown,
  status = 200,
) {
  return NextResponse.json(body, {
    status,
    headers: corsHeaders(request),
  })
}

export function corsOptions(request: NextRequest) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request),
  })
}
