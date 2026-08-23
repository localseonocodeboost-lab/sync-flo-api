const STRIP_QUERY_PARAMS = ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","gclid","fbclid","msclkid","mc_cid","mc_eid","ref","ref_src","_ga","sessionid","phpsessid"]
const SKIP_EXTENSIONS = [".jpg",".jpeg",".png",".gif",".webp",".svg",".ico",".bmp",".tiff",".pdf",".doc",".docx",".xls",".xlsx",".ppt",".pptx",".zip",".rar",".gz",".tar",".mp3",".mp4",".avi",".mov",".wmv",".css",".js",".json",".xml",".rss",".woff",".woff2",".ttf",".eot"]
const SKIP_PATH_PATTERNS = ["/wp-admin","/wp-login","/admin","/administrator","/login","/signin","/sign-in","/logout","/register","/signup","/sign-up","/account","/my-account","/cart","/basket","/checkout","/wishlist","/search","/?s=","/tag/","/tags/","/author/","/feed","/cdn-cgi/","/wp-json","/xmlrpc"]

export function normalizeHostname(hostname: string): string { return hostname.toLowerCase().replace(/^www\./, "") }

export function canonicalizeUrl(rawUrl: string, base?: string): string | null {
  let url: URL
  try { url = base ? new URL(rawUrl, base) : new URL(rawUrl) } catch { return null }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  url.hash = ""; url.hostname = url.hostname.toLowerCase()
  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = ""
  for (const param of STRIP_QUERY_PARAMS) url.searchParams.delete(param)
  url.searchParams.sort()
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.replace(/\/+$/, "")
  return url.href
}

export function isSameSite(url: string, rootHostname: string): boolean {
  try { return normalizeHostname(new URL(url).hostname) === normalizeHostname(rootHostname) }
  catch { return false }
}

export function isCrawlableUrl(rawUrl: string): boolean {
  let url: URL
  try { url = new URL(rawUrl) } catch { return false }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  const path = url.pathname.toLowerCase()
  for (const ext of SKIP_EXTENSIONS) if (path.endsWith(ext)) return false
  const haystack = (url.pathname + url.search).toLowerCase()
  for (const pattern of SKIP_PATH_PATTERNS) if (haystack.includes(pattern)) return false
  if (/\/page\/\d+/.test(path)) return false
  if (url.searchParams.has("page") && Number(url.searchParams.get("page")) > 1) return false
  return true
}

export function urlPriority(rawUrl: string, anchorText: string, service: string, location: string): number {
  let url: URL
  try { url = new URL(rawUrl) } catch { return 0 }
  const path = url.pathname.toLowerCase(), anchor = anchorText.toLowerCase()
  const serviceTokens = tokenize(service), locationTokens = tokenize(location)
  let score = 0
  const depth = path.split("/").filter(Boolean).length
  score += Math.max(0, 5 - depth)
  if (serviceTokens.some((t) => path.includes(t) || anchor.includes(t))) score += 40
  if (locationTokens.some((t) => path.includes(t) || anchor.includes(t))) score += 35
  if (/(services|service)\b/.test(path)) score += 30
  if (/(areas?-we-cover|areas?-covered|locations?|coverage|towns?|where-we-work)/.test(path)) score += 28
  if (/(contact)/.test(path) || /contact/.test(anchor)) score += 25
  if (/(about|who-we-are|our-story|meet-the-team)/.test(path)) score += 20
  if (/(pricing|prices|quote|book)/.test(path)) score += 10
  if (/\/\d{4}\/\d{2}\//.test(path)) score -= 10
  if (/\/(blog|news|posts?)\//.test(path)) score -= 5
  return score
}

export function tokenize(input: string): string[] {
  return input.toLowerCase().split(/[^a-z0-9]+/).map((t) => t.trim()).filter((t) => t.length >= 3)
}
