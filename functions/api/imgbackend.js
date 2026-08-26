export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const query = url.searchParams.get("q");
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
    // 1. ZERO-LEAK BINARY IMAGE PROXY PIPE (WITH SVG 404 FALLBACK)
    // =========================================================================
    if (proxyImgUrl) {
      try {
        const decodedUrl = decodeURIComponent(proxyImgUrl);
        const imgRes = await fetch(decodedUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
          },
          signal: AbortSignal.timeout(5000)
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

      // Return a clean inline SVG fallback instead of raw HTTP 404
      const fallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300" fill="none"><rect width="300" height="300" fill="#171B26"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#64748B" font-family="sans-serif" font-size="14" font-weight="bold">Image Unavailable</text></svg>`;
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
    // 2. MULTI-ENGINE SEARCH MATRIX (DDG + QWANT + OPENVERSE + WIKIMEDIA)
    // =========================================================================
    if (query) {
      let aggregatedResults = [];
      const pageIndex = Math.floor(offset / 10) + 1;

      // --- ENGINE 1: DuckDuckGo Keyless API ---
      try {
        const tokenRes = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
          },
          signal: AbortSignal.timeout(4000)
        });

        if (tokenRes.ok) {
          const html = await tokenRes.text();
          const vqdMatch = html.match(/vqd=['"]?([^&'"]+)/i);

          if (vqdMatch && vqdMatch[1]) {
            const vqd = vqdMatch[1];
            const ddgApiUrl = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${encodeURIComponent(vqd)}&f=,,,;&p=${pageIndex}`;

            const ddgRes = await fetch(ddgApiUrl, {
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Referer": "https://duckduckgo.com/"
              },
              signal: AbortSignal.timeout(4000)
            });

            if (ddgRes.ok) {
              const ddgData = await ddgRes.json();
              (ddgData.results || []).forEach(item => {
                if (item.image) {
                  aggregatedResults.push({
                    title: item.title || "Image",
                    image: `/api/imgbackend?proxy_img=${encodeURIComponent(item.image)}`,
                    thumbnail: `/api/imgbackend?proxy_img=${encodeURIComponent(item.thumbnail || item.image)}`,
                    source: "DuckDuckGo",
                    width: item.width || 0,
                    height: item.height || 0
                  });
                }
              });
            }
          }
        }
      } catch (err) {}

      // --- ENGINE 2: Qwant Open JSON API (Fallback) ---
      if (aggregatedResults.length < 15) {
        try {
          const qwantUrl = `https://api.qwant.com/v3/search/images?q=${encodeURIComponent(query)}&count=15&offset=${offset}&locale=en_US`;
          const qwantRes = await fetch(qwantUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            },
            signal: AbortSignal.timeout(3500)
          });

          if (qwantRes.ok) {
            const qwantData = await qwantRes.json();
            const items = qwantData?.data?.result?.items || [];
            items.forEach(item => {
              if (item.media) {
                aggregatedResults.push({
                  title: item.title || "Image",
                  image: `/api/imgbackend?proxy_img=${encodeURIComponent(item.media)}`,
                  thumbnail: `/api/imgbackend?proxy_img=${encodeURIComponent(item.thumbnail || item.media)}`,
                  source: "Qwant",
                  width: item.width || 0,
                  height: item.height || 0
                });
              }
            });
          }
        } catch (e) {}
      }

      // --- ENGINE 3: Openverse CC Image Hub ---
      if (aggregatedResults.length < 15) {
        try {
          const ovUrl = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=15&page=${pageIndex}`;
          const ovRes = await fetch(ovUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MeshRelay/2.0"
            },
            signal: AbortSignal.timeout(3500)
          });

          if (ovRes.ok) {
            const ovData = await ovRes.json();
            (ovData.results || []).forEach(item => {
              if (item.url) {
                aggregatedResults.push({
                  title: item.title || "Image",
                  image: `/api/imgbackend?proxy_img=${encodeURIComponent(item.url)}`,
                  thumbnail: `/api/imgbackend?proxy_img=${encodeURIComponent(item.thumbnail || item.url)}`,
                  source: "Openverse",
                  width: item.width || 0,
                  height: item.height || 0
                });
              }
            });
          }
        } catch (e) {}
      }

      // --- ENGINE 4: Wikimedia Commons Open Search ---
      if (aggregatedResults.length < 15) {
        try {
          const wikiRes = await fetch(`https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(query)}&gsrlimit=15&gsroffset=${offset}&prop=imageinfo&iiprop=url|size|mime&format=json&origin=*`, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MeshRelay/2.0" },
            signal: AbortSignal.timeout(3500)
          });

          if (wikiRes.ok) {
            const wikiData = await wikiRes.json();
            const pages = wikiData?.query?.pages || {};

            Object.values(pages).forEach(page => {
              const info = page.imageinfo?.[0];
              if (info && info.url && !info.mime?.includes("svg") && !info.mime?.includes("pdf")) {
                aggregatedResults.push({
                  title: (page.title || "Image").replace(/^File:/i, ""),
                  image: `/api/imgbackend?proxy_img=${encodeURIComponent(info.url)}`,
                  thumbnail: `/api/imgbackend?proxy_img=${encodeURIComponent(info.thumburl || info.url)}`,
                  source: "Wikimedia",
                  width: info.width || 0,
                  height: info.height || 0
                });
              }
            });
          }
        } catch (err) {}
      }

      if (aggregatedResults.length === 0) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: offset > 0 ? "End of search results reached." : "No images found for this query." 
        }), {
          headers: jsonHeaders
        });
      }

      // Slice the active window (3 per page)
      const relativeOffset = offset % aggregatedResults.length;
      const pageResults = aggregatedResults.slice(relativeOffset, relativeOffset + 3);
      const hasNext = aggregatedResults.length > relativeOffset + 3 || aggregatedResults.length >= 10;

      return new Response(JSON.stringify({
        success: true,
        query: query,
        offset: offset,
        hasNext: hasNext,
        results: pageResults.length > 0 ? pageResults : aggregatedResults.slice(0, 3)
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
