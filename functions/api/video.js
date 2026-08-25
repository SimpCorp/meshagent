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

    // --- 2. PROXIED STREAM (Direct InnerTube Extraction + Range Piping) ---
    if (streamId) {
      const videoId = streamId;

      // Query YouTube's internal InnerTube Player API from Cloudflare edge
      const innertubeRes = await fetch(`https://www.youtube.com/youtubei/v1/player`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: "WEB",
              clientVersion: "2.20240501.00.00",
              hl: "en",
              gl: "US"
            }
          },
          videoId: videoId
        }),
        signal: AbortSignal.timeout(6000)
      });

      if (!innertubeRes.ok) {
        return new Response(JSON.stringify({ success: false, error: "InnerTube API connection failed at edge." }), { headers: jsonHeaders, status: 502 });
      }

      const playerData = await innertubeRes.json();
      const formats = playerData?.streamingData?.formats || [];
      const adaptiveFormats = playerData?.streamingData?.adaptiveFormats || [];
      
      const allFormats = [...formats, ...adaptiveFormats];
      const mp4Stream = allFormats.find(f => f.mimeType?.includes("video/mp4") && f.url);

      if (!mp4Stream || !mp4Stream.url) {
        return new Response(JSON.stringify({ success: false, error: "No accessible MP4 stream format found for this video ID." }), { headers: jsonHeaders, status: 404 });
      }

      // Forward client byte-range request for smooth seeking and buffering past 0:00
      const rangeHeader = request.headers.get("Range");
      const upstreamHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        ...(rangeHeader ? { "Range": rangeHeader } : {})
      };

      const videoByteRes = await fetch(mp4Stream.url, { headers: upstreamHeaders });

      if (videoByteRes.ok || videoByteRes.status === 206) {
        const respHeaders = new Headers(videoByteRes.headers);
        respHeaders.set("Access-Control-Allow-Origin", "*");
        respHeaders.set("Content-Type", "video/mp4");
        
        return new Response(videoByteRes.body, {
          status: videoByteRes.status,
          headers: respHeaders
        });
      }

      return new Response(JSON.stringify({ success: false, error: "Upstream video byte stream error." }), { headers: jsonHeaders, status: 502 });
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
        return new Response(JSON.stringify({ success: false, error: `Upstream search failed with status ${searchRes.status}` }), { headers: jsonHeaders });
      }

      const html = await searchRes.text();
      const match = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData = ({.*?});/s);

      if (!match || !match[1]) {
        return new Response(JSON.stringify({ success: false, error: "Unable to parse video metadata from response." }), { headers: jsonHeaders });
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

    return new Response(JSON.stringify({ success: false, error: "Missing parameters." }), { headers: jsonHeaders, status: 400 });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: "Edge worker exception: " + err.message }), { headers: jsonHeaders, status: 500 });
  }
}
