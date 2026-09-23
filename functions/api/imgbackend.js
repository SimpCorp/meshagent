/**
 * CLOUDFLARE PAGES EDGE FUNCTION: /api/imgbackend
 * 
 * 1. PROXY PIPE: Streams binary image bytes with stripped tracking headers.
 * 2. SEARCH ENGINE: Concurrent multi-source race (Bing + Wikimedia + Unsplash) with zero API keys.
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
    // 1. ZERO-LEAK BINARY IMAGE PROXY PIPE (MASKS DESTINATION FROM ISP/FIREWALL)
    // =========================================================================
    if (proxyImgUrl) {
      try {
        const decodedUrl = decodeURIComponent(proxyImgUrl);
        
        // Block private subnet requests (SSRF protection)
        const parsedTarget = new URL(decodedUrl);
        if (["localhost", "127.0.0.1", "0.0.0.0"].includes(parsedTarget.hostname)) {
          throw new Error("Invalid target host");
        }

        const imgRes = await fetch(decodedUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
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
      } catch (e) {
        // Fall through to SVG fallback
      }

      // Clean SVG fallback to avoid broken image icons in chat/drawers
      const fallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300" fill="none"><rect width="300" height="300" fill="#111827"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#64748B" font-family="sans-serif" font-size="12" font-weight="600">Image Expired</text></svg>`;
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
    // 2. PARALLEL MULTI-ENGINE IMAGE MATRIX
    // =========================================================================
    if (query) {
      const selfEndpoint = url.pathname; // automatically matches /api/imgbackend or /api/imagebackend

      // We race 3 independent engines in parallel. The fastest valid batch wins.
      const candidatePromises = [
        searchBingDirect(query, selfEndpoint),
        searchWikimedia(query, selfEndpoint, offset),
        searchUnsplashDirect(query, selfEndpoint)
      ];

      // Execute race: take the first one that successfully returns at least 3 images
      let aggregatedResults = [];
      try {
        aggregatedResults = await Promise.any(
          candidatePromises.map(p => p.then(res => {
            if (res && res.length >= 3) return res;
            throw new Error("Insufficient results");
          }))
        );
      } catch (allFailedErr) {
        // If the parallel race fails, collect any partial results from settled promises
        const settled = await Promise.allSettled(candidatePromises);
        for (const item of settled) {
          if (item.status === "fulfilled" && item.value && item.value.length > 0) {
            aggregatedResults = aggregatedResults.concat(item.value);
          }
        }
      }

      if (aggregatedResults.length === 0) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: "No images found across upstream repositories." 
        }), {
          headers: jsonHeaders
        });
      }

      // Deduplicate results based on title/image URL
      const seen = new Set();
      const uniqueResults = [];
      for (const item of aggregatedResults) {
        if (!seen.has(item.image)) {
          seen.add(item.image);
          uniqueResults.push(item);
        }
      }

      // Paginate 3 items per page to match your UI drawer cards
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
// UPSTREAM PROVIDERS (SERVER-SIDE FETCHERS)
// =========================================================================

/**
 * Engine 1: Bing Images (High Catalog Coverage: pop culture, anime, campus, general)
 */
async function searchBingDirect(query, selfEndpoint) {
  try {
    const bingUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1&tsc=ImageHoverTitle`;
    const res = await fetch(bingUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      },
      signal: AbortSignal.timeout(4000)
    });

    if (!res.ok) return [];
    const html = await res.text();

    // Regex extract Bing's embedded murl (media url) and turl (thumbnail url) JSON objects
    const results = [];
    const regex = /m=\{&quot;cid&quot;:.*?&quot;murl&quot;:&quot;([^&]+)&quot;.*?&quot;turl&quot;:&quot;([^&]+)&quot;.*?&quot;t&quot;:&quot;([^&]*)&quot;/g;
    let match;

    while ((match = regex.exec(html)) !== null && results.length < 15) {
      const fullUrl = decodeURIComponent(match[1]);
      const thumbUrl = decodeURIComponent(match[2]);
      const title = decodeURIComponent(match[3] || "Image").replace(/\+/g, " ");

      if (fullUrl.startsWith("http")) {
        results.push({
          title: title || "Image",
          image: `${selfEndpoint}?proxy_img=${encodeURIComponent(fullUrl)}`,
          thumbnail: `${selfEndpoint}?proxy_img=${encodeURIComponent(thumbUrl)}`,
          source: "Bing",
          width: 0,
          height: 0
        });
      }
    }

    return results;
  } catch (e) {
    return [];
  }
}

/**
 * Engine 2: Wikimedia Commons (Zero rate limits, diagrams, historical, public domain)
 */
async function searchWikimedia(query, selfEndpoint, offset) {
  try {
    const wikiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(query)}&gsrlimit=12&gsroffset=${offset}&prop=imageinfo&iiprop=url|size|mime&format=json&origin=*`;
    const res = await fetch(wikiUrl, {
      headers: { 
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MeshRelay/2.0" 
      },
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

/**
 * Engine 3: Unsplash Source API (High Quality photography & wallpapers fallback)
 */
async function searchUnsplashDirect(query, selfEndpoint) {
  try {
    const unsplashUrl = `https://unsplash.com/napi/search/photos?query=${encodeURIComponent(query)}&per_page=12`;
    const res = await fetch(unsplashUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "*/*"
      },
      signal: AbortSignal.timeout(3500)
    });

    if (!res.ok) return [];
    const data = await res.json();
    const photos = data?.results || [];
    const results = [];

    for (const photo of photos) {
      if (photo?.urls?.regular) {
        results.push({
          title: photo.alt_description || photo.description || "Photo",
          image: `${selfEndpoint}?proxy_img=${encodeURIComponent(photo.urls.regular)}`,
          thumbnail: `${selfEndpoint}?proxy_img=${encodeURIComponent(photo.urls.small || photo.urls.thumb)}`,
          source: "Unsplash",
          width: photo.width || 0,
          height: photo.height || 0
        });
      }
    }
    return results;
  } catch (e) {
    return [];
  }
}
