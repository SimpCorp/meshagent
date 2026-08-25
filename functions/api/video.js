export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const query = url.searchParams.get("q");
  const videoId = url.searchParams.get("id");
  const thumbId = url.searchParams.get("thumb");

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // --- 1. PROXIED THUMBNAIL (Bypasses ytimg.com block) ---
  if (thumbId) {
    try {
      const imgRes = await fetch(`https://i.ytimg.com/vi/${encodeURIComponent(thumbId)}/hqdefault.jpg`, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      if (imgRes.ok) {
        return new Response(imgRes.body, {
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "public, max-age=86400"
          }
        });
      }
    } catch (e) {}
    return new Response(null, { status: 404 });
  }

  // --- 2. DIRECT YOUTUBE SEARCH SCRAPER ON CLOUDFLARE EDGE ---
  if (query) {
    try {
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
      const res = await fetch(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9"
        },
        signal: AbortSignal.timeout(6000)
      });

      if (!res.ok) {
        return new Response(JSON.stringify({ success: false, error: "Search upstream failed." }), { headers: corsHeaders });
      }

      const html = await res.text();
      const match = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData = ({.*?});/s);

      if (!match || !match[1]) {
        return new Response(JSON.stringify({ success: false, error: "Unable to parse search results." }), { headers: corsHeaders });
      }

      const data = JSON.parse(match[1]);
      const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;

      let rawVideos = [];
      if (Array.isArray(contents)) {
        for (const section of contents) {
          const itemSection = section?.itemSectionRenderer?.contents;
          if (Array.isArray(itemSection)) {
            for (const item of itemSection) {
              if (item.videoRenderer && item.videoRenderer.videoId) {
                const vr = item.videoRenderer;
                rawVideos.push({
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

      const top3 = rawVideos.slice(0, 3);

      if (top3.length > 0) {
        return new Response(JSON.stringify({ success: true, results: top3 }), { headers: corsHeaders });
      } else {
        return new Response(JSON.stringify({ success: false, error: "No video matches found." }), { headers: corsHeaders });
      }
    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: "Edge search error: " + err.message }), { headers: corsHeaders });
    }
  }

  // --- 3. VIDEO EMBED/STREAM GENERATION ---
  if (videoId) {
    // Generate a sandboxed privacy-shielded player configuration
    return new Response(JSON.stringify({
      success: true,
      videoId: videoId,
      embedUrl: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1&modestbranding=1&rel=0`
    }), { headers: corsHeaders });
  }

  return new Response(JSON.stringify({ error: "Invalid parameters" }), { headers: corsHeaders, status: 400 });
}
