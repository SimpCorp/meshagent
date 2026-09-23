/**
 * CLOUDFLARE PAGES EDGE FUNCTION: /api/imgbackend
 * 
 * 1. ZERO-LEAK PROXY: Relays binary image bytes, hiding source hosts from campus ISP/firewalls.
 * 2. 50/50 BALANCED SEARCH: Dynamically filters NSFW unless requested, interleaving Web + Wikimedia evenly.
 */

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);
  const proxyImgUrl = url.searchParams.get("proxy_img");

  const jsonHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: jsonHeaders });
  }

  try {
    // =========================================================================
    // 1. ZERO-LEAK BINARY IMAGE PROXY PIPE
    // =========================================================================
    if (proxyImgUrl) {
      try {
        const decodedUrl = decodeURIComponent(proxyImgUrl);
        const parsedTarget = new URL(decodedUrl);
        
        // Block private subnet requests (SSRF protection)
        if (["localhost", "127.0.0.1", "0.0.0.0"].includes(parsedTarget.hostname)) {
          throw new Error("Invalid target host");
        }

        const imgRes = await fetch(decodedUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            "Referer": parsedTarget.origin + "/"
          },
          signal: AbortSignal.timeout(6000)
        });

        if (imgRes.ok) {
          const contentType = imgRes.headers.get("content-type") || "image/jpeg";
          return new Response(imgRes.body, {
            status: 200,
            headers: {
              "Content-Type": contentType,
              "Cache-Control": "public, max-age=86400",
              "Access-Control-Allow-Origin": "*",
              "X-Content-Type-Options": "nosniff"
            }
          });
        }
      } catch (e) {}

      // Clean SVG fallback to avoid broken image icons in chat/drawers
      const fallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300" fill="none"><rect width="300" height="300" fill="#0B0F17"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#64748B" font-family="sans-serif" font-size="12" font-weight="600">Image Expired</text></svg>`;
      return new Response(fallbackSvg, {
        status: 200,
        headers: {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=3600",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // =========================================================================
    // 2. EQUAL-WEIGHT SEARCH MATRIX (WEB + WIKIMEDIA)
    // =========================================================================
    if (query) {
      const selfEndpoint = url.pathname;

      // Detect if user explicitly requested adult content
      const adultIntentRegex = /\b(nsfw|18\+|porn|nude|sex|hentai|rule34|r18|lewd)\b/i;
      const explicitRequested = adultIntentRegex.test(query);

      // Concurrently query both Web and Wikimedia
      const [webResults, wikiResults] = await Promise.all([
        searchWeb(query, selfEndpoint, explicitRequested),
        searchWikimedia(query, selfEndpoint, offset)
      ]);

      // Interleave results 50/50: [Web, Wiki, Web, Wiki, ...]
      const combined = [];
      const maxLen = Math.max(webResults.length, wikiResults.length);
      for (let i = 0; i < maxLen; i++) {
        if (webResults[i]) combined.push(webResults[i]);
        if (wikiResults[i]) combined.push(wikiResults[i]);
      }

      if (combined.length === 0) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: "No images found for this query." 
        }), {
          headers: jsonHeaders
        });
      }

      // Deduplicate results based on image URL
      const seen = new Set();
      const uniqueResults = [];
      for (const item of combined) {
        if (!seen.has(item.image)) {
          seen.add(item.image);
          uniqueResults.push(item);
        }
      }

      const relativeOffset = offset % uniqueResults.length;
      const pageResults = uniqueResults.slice(relativeOffset, relativeOffset + 3);
      const hasNext = uniqueResults.length > relativeOffset + 3 || uniqueResults.length >= 10;

      return new Response(JSON.stringify({
        success: true,
        query: query,
        offset: offset,
        hasNext: hasNext,
        results: pageResults.length > 0 ? pageResults : uniqueResults.slice(0, 3)
      }), {
        headers: jsonHeaders
      });
    }

    return new Response(JSON.stringify({ success: false, error: "Missing required query parameter" }), {
      headers: jsonHeaders,
      status: 400
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: "Worker error: " + err.message }), {
      headers: jsonHeaders,
      status: 500
    });
  }
}

// =========================================================================
// SEARCH ENGINE FETCHERS
// =========================================================================

/**
 * Engine 1: Web Index (Bing Scraping with Dynamic Safety Mode)
 */
async function searchWeb(query, selfEndpoint, explicitRequested) {
  try {
    // Only drop adult filtering if user explicitly entered mature keywords
    const adltParam = explicitRequested ? "off" : "moderate";
    const cookieHeader = explicitRequested ? "SRCHHPGUSR=ADLT=OFF&NRSLT=-1;" : "SRCHHPGUSR=ADLT=DEMOTE&NRSLT=-1;";

    const targetUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1&adlt=${adltParam}`;
    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cookie": cookieHeader
      },
      signal: AbortSignal.timeout(4500)
    });

    if (!res.ok) return [];
    const html = await res.text();

    // Target the primary image results grid exclusively to avoid trending sidebars
    let searchArea = html;
    const gridMatch = html.match(/id="mmComponent_images_1"[\s\S]*?<\/ul>/i) || html.match(/class="dgControl[\s\S]*?<\/ul>/i);
    if (gridMatch) {
      searchArea = gridMatch[0];
    }

    const results = [];
    const blockRegex = /class="iusc"[^>]*?(?:m|data-m)="({.+?})"/g;
    let match;

    while ((match = blockRegex.exec(searchArea)) !== null && results.length < 15) {
      try {
        const rawJson = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        const parsed = JSON.parse(rawJson);

        const murl = parsed.murl;
        const turl = parsed.turl || parsed.murl;
        const title = parsed.t || parsed.desc || "Image";

        if (murl && murl.startsWith("http")) {
          results.push({
            title: title.replace(/\+/g, " "),
            image: `${selfEndpoint}?proxy_img=${encodeURIComponent(murl)}`,
            thumbnail: `${selfEndpoint}?proxy_img=${encodeURIComponent(turl)}`,
            source: "Web",
            width: parsed.mw || 0,
            height: parsed.mh || 0
          });
        }
      } catch (err) {}
    }

    return results;
  } catch (e) {
    return [];
  }
}

/**
 * Engine 2: Wikimedia Commons (High-Reliability Open Media)
 */
async function searchWikimedia(query, selfEndpoint, offset) {
  try {
    const wikiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(query)}&gsrlimit=12&gsroffset=${offset}&prop=imageinfo&iiprop=url|size|mime&format=json&origin=*`;
    const res = await fetch(wikiUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MeshRelay/2.0" },
      signal: AbortSignal.timeout(3500)
    });

    if (!res.ok) return [];
    const data = await res.json();
    const pages = data?.query?.pages || {};
    const results = [];

    for (const page of Object.values(pages)) {
      const info = page.imageinfo?.[0];
      if (info && info.url && !info.mime?.includes("svg") && !info.mime?.includes("pdf")) {
        const title = (page.title || "Image").replace(/^File:/i, "");
        results.push({
          title: title,
          image: `${selfEndpoint}?proxy_img=${encodeURIComponent(info.url)}`,
          thumbnail: `${selfEndpoint}?proxy_img=${encodeURIComponent(info.thumburl || info.url)}`,
          source: "Wikimedia",
          width: info.width || 0,
          height: info.height || 0
        });
      }
    }
    return results;
  } catch (e) {
    return [];
  }
}
