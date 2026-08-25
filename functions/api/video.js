export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const query = url.searchParams.get("q");
  const streamId = url.searchParams.get("stream");
  const thumbId = url.searchParams.get("thumb");

  const jsonHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: jsonHeaders });
  }

  try {
    // --- 1. PROXIED THUMBNAIL (0 client leaks) ---
    if (thumbId) {
      try {
        const imgRes = await fetch(`https://i.ytimg.com/vi/${encodeURIComponent(thumbId)}/hqdefault.jpg`, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(4000)
        });
        if (imgRes.ok) {
          return new Response(imgRes.body, {
            headers: {
              "Content-Type": "image/jpeg",
              "Cache-Control": "public, max-age=86400",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }
      } catch (e) {}
      return new Response(null, { status: 404 });
    }

    // --- 2. PROXIED STREAM (Direct Binary Pipe) ---
    if (streamId) {
      const videoId = encodeURIComponent(streamId);
      const relayEndpoints = [
        `https://pipedapi.kavin.rocks/streams/${videoId}`,
        `https://api.piped.privacydev.net/streams/${videoId}`,
        `https://piped-api.lunar.icu/streams/${videoId}`
      ];

      for (const endpoint of relayEndpoints) {
        try {
          const metaRes = await fetch(endpoint, {
            headers: { "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(3500)
          });
          if (!metaRes.ok) continue;
          const meta = await metaRes.json();

          const videoStreams = (meta.videoStreams || []).filter(s => !s.videoOnly && s.mimeType?.includes("mp4"));
          const target = videoStreams.find(s => s.quality === "360p") || videoStreams.find(s => s.quality === "720p") || videoStreams[0];

          if (target && target.url) {
            const range = request.headers.get("Range");
            const fetchHeaders = {
              "User-Agent": "Mozilla/5.0",
              ...(range ? { "Range": range } : {})
            };

            const streamRes = await fetch(target.url, { headers: fetchHeaders });
            if (streamRes.ok || streamRes.status === 206) {
              const respHeaders = new Headers(streamRes.headers);
              respHeaders.set("Access-Control-Allow-Origin", "*");
              respHeaders.set("Content-Type", "video/mp4");
              return new Response(streamRes.body, {
                status: streamRes.status,
                headers: respHeaders
              });
            }
          }
        } catch (err) {
          continue;
        }
      }

      return new Response(JSON.stringify({ success: false, error: "Stream unavailable from upstream relays." }), {
        headers: jsonHeaders,
        status: 502
      });
    }

    // --- 3. ZERO-LEAK SEARCH SCRAPER ---
    if (query) {
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
      const searchRes = await fetch(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          "Cookie": "CONSENT=PENDING+999; SOCS=CAESEwgDEgk2MTc4OTk1MzQaAmVuIAEaBgiA_LyaBg"
        },
        signal: AbortSignal.timeout(5000)
      });

      if (!searchRes.ok) {
        return new Response(JSON.stringify({ success: false, error: `Upstream returned status ${searchRes.status}` }), {
          headers: jsonHeaders
        });
      }

      const html = await searchRes.text();
      const match = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData = ({.*?});/s);

      if (!match || !match[1]) {
        return new Response(JSON.stringify({ success: false, error: "Unable to parse video results from response." }), {
          headers: jsonHeaders
        });
      }

      const parsed = JSON.parse(match[1]);
      const contents = parsed?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;

      let results = [];
      if (Array.isArray(contents)) {
        for (const sec of contents) {
          const items = sec?.itemSectionRenderer?.contents;
          if (Array.isArray(items)) {
            for (const it of items) {
              if (it.videoRenderer && it.videoRenderer.videoId) {
                const vr = it.videoRenderer;
                results.push({
                  id: vr.videoId,
                  title: vr.title?.runs?.[0]?.text || vr.title?.simpleText || "Video",
                  uploader: vr.ownerText?.runs?.[0]?.text || "Creator",
                  duration: vr.lengthText?.simpleText || "Video",
                  thumbnail: `/api/video?thumb=${vr.videoId}`
                });
              }
            }
          }
        }
      }

      const top3 = results.slice(0, 3);
      if (top3.length > 0) {
        return new Response(JSON.stringify({ success: true, results: top3 }), { headers: jsonHeaders });
      } else {
        return new Response(JSON.stringify({ success: false, error: "No video results found for that query." }), { headers: jsonHeaders });
      }
    }

    return new Response(JSON.stringify({ success: false, error: "Missing parameter 'q', 'stream', or 'thumb'" }), {
      headers: jsonHeaders,
      status: 400
    });

  } catch (globalErr) {
    return new Response(JSON.stringify({ success: false, error: "Edge runtime exception: " + globalErr.message }), {
      headers: jsonHeaders,
      status: 500
    });
  }
}
