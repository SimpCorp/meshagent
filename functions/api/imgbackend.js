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
    // 1. ZERO-LEAK BINARY IMAGE PROXY PIPE
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
      return new Response(null, { status: 404 });
    }

    // =========================================================================
    // 2. MULTI-SOURCE KEYLESS IMAGE SCRAPER (DUCKDUCKGO + WIKIMEDIA)
    // =========================================================================
    if (query) {
      let aggregatedResults = [];

      // Engine A: DuckDuckGo Keyless Image API
      try {
        // Step 1: Obtain the VQD session token from DuckDuckGo search
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
            const ddgApiUrl = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${encodeURIComponent(vqd)}&f=,,,;&p=1`;

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

      // Engine B: Wikimedia Commons Open Search (Fallback / Complementary)
      if (aggregatedResults.length < 6) {
        try {
          const wikiRes = await fetch(`https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(query)}&gsrlimit=12&prop=imageinfo&iiprop=url|size|mime&format=json&origin=*`, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MeshRelay/1.0"
            },
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
        return new Response(JSON.stringify({ success: false, error: "No image results found." }), {
          headers: jsonHeaders
        });
      }

      const pageResults = aggregatedResults.slice(offset, offset + 3);
      const hasNext = aggregatedResults.length > offset + 3;

      return new Response(JSON.stringify({
        success: true,
        query: query,
        offset: offset,
        hasNext: hasNext,
        results: pageResults
      }), {
        headers: jsonHeaders
      });
    }

    return new Response(JSON.stringify({ success: false, error: "Missing required parameter" }), {
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
