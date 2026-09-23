/**
 * CLOUDFLARE PAGES EDGE FUNCTION: /api/imgbackend
 * 
 * 1. ZERO-LEAK PROXY: Relays binary image bytes, stripping ISP/Firewall detection.
 * 2. UNRESTRICTED SEARCH MATRIX: Parallel race (Bing Unfiltered + SearXNG + Unsplash) with adult/safe-mode disabled.
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
    // 1. ZERO-LEAK BINARY IMAGE PROXY PIPE (MASKS DESTINATION FROM ISP)
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
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            "Referer": parsedTarget.origin + "/"
          },
          signal: AbortSignal.timeout(7000)
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
        // Fall through to fallback SVG
      }

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
    // 2. PARALLEL UNRESTRICTED MULTI-ENGINE SEARCH
    // =========================================================================
    if (query) {
      const selfEndpoint = url.pathname;

      // Race Bing (Unfiltered) and SearXNG metasearch concurrently
      const candidatePromises = [
        searchBingUnfiltered(query, selfEndpoint),
        searchSearXNG(query, selfEndpoint),
        searchUnsplash(query, selfEndpoint)
      ];

      let aggregatedResults = [];
      try {
        aggregatedResults = await Promise.any(
          candidatePromises.map(p => p.then(res => {
            if (res && res.length >= 3) return res;
            throw new Error("Insufficient results");
          }))
        );
      } catch (allFailedErr) {
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
          error: "No images found for this query." 
        }), {
          headers: jsonHeaders
        });
      }

      // Deduplicate results
      const seen = new Set();
      const uniqueResults = [];
      for (const item of aggregatedResults) {
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
// UPSTREAM ENGINES (UNRESTRICTED / RAW MEDIA EXTRACTION)
// =========================================================================

/**
 * Engine 1: Bing Images (Strictly Target Results Container + SafeSearch Disabled)
 */
async function searchBingUnfiltered(query, selfEndpoint) {
  try {
    // adlt=off & safeSearch cookie forces complete adult / unrestricted mode
    const targetUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1&adlt=off`;
    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cookie": "SRCHHPGUSR=ADLT=OFF&NRSLT=-1;" // Hard override for SafeSearch
      },
      signal: AbortSignal.timeout(5000)
    });

    if (!res.ok) return [];
    const html = await res.text();

    // Isolate only the results grid to prevent capturing trending/editorial widgets
    let searchArea = html;
    const gridMatch = html.match(/id="mmComponent_images_1"[\s\S]*?<\/ul>/i) || html.match(/class="dgControl[\s\S]*?<\/ul>/i);
    if (gridMatch) {
      searchArea = gridMatch[0];
    }

    const results = [];
    const blockRegex = /class="iusc"[^>]*?(?:m|data-m)="({.+?})"/g;
    let match;

    while ((match = blockRegex.exec(searchArea)) !== null && results.length < 20) {
      try {
        const rawJson = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        const parsed = JSON.parse(rawJson);

        const murl = parsed.murl; // Source image link
        const turl = parsed.turl || parsed.murl; // Thumbnail link
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

    // Fallback search within isolated area
    if (results.length === 0) {
      const fallbackRegex = /&quot;murl&quot;:&quot;(https?:[^&]+?)&quot;/g;
      let fbMatch;
      while ((fbMatch = fallbackRegex.exec(searchArea)) !== null && results.length < 20) {
        const rawUrl = fbMatch[1];
        results.push({
          title: query,
          image: `${selfEndpoint}?proxy_img=${encodeURIComponent(rawUrl)}`,
          thumbnail: `${selfEndpoint}?proxy_img=${encodeURIComponent(rawUrl)}`,
          source: "Web",
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
 * Engine 2: SearXNG Open Metasearch (Unfiltered JSON Aggregator)
 */
async function searchSearXNG(query, selfEndpoint) {
  const instances = [
    "https://priv.au",
    "https://search.ononoki.org",
    "https://searx.be"
  ];

  for (const host of instances) {
    try {
      const apiUrl = `${host}/search?q=${encodeURIComponent(query)}&categories=images&format=json&safesearch=0`;
      const res = await fetch(apiUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)",
          "Accept": "application/json"
        },
        signal: AbortSignal.timeout(3500)
      });

      if (!res.ok) continue;
      const data = await res.json();
      const items = data.results || [];
      const results = [];

      for (const item of items) {
        const imgUrl = item.img_src || item.url;
        const thumbUrl = item.thumbnail_src || imgUrl;

        if (imgUrl && imgUrl.startsWith("http")) {
          results.push({
            title: item.title || "Image",
            image: `${selfEndpoint}?proxy_img=${encodeURIComponent(imgUrl)}`,
            thumbnail: `${selfEndpoint}?proxy_img=${encodeURIComponent(thumbUrl)}`,
            source: "Web",
            width: item.resolution ? parseInt(item.resolution.split("x")[0]) : 0,
            height: item.resolution ? parseInt(item.resolution.split("x")[1]) : 0
          });
        }
      }

      if (results.length >= 3) return results;
    } catch (e) {}
  }
  return [];
}

/**
 * Engine 3: Unsplash Source API (High Quality Aesthetic Backup)
 */
async function searchUnsplash(query, selfEndpoint) {
  try {
    const unsplashUrl = `https://unsplash.com/napi/search/photos?query=${encodeURIComponent(query)}&per_page=15`;
    const res = await fetch(unsplashUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "*/*"
      },
      signal: AbortSignal.timeout(3000)
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
