/**
 * CLOUDFLARE PAGES EDGE FUNCTION: /api/music
 * Robust Search & Stream Relay
 */

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode");

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "X-Content-Type-Options": "nosniff"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // =========================================================================
  // 1. SEARCH ENDPOINT
  // =========================================================================
  if (mode === "search") {
    const query = (url.searchParams.get("q") || "").trim();
    if (!query) {
      return new Response(JSON.stringify({ tracks: [] }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    try {
      // Direct call to public search endpoint with standard headers
      const targetEndpoint = `https://www.jiosaavn.com/api.php?__call=autocomplete.get&_format=json&_marker=0&cc=in&includeMetaTags=1&query=${encodeURIComponent(query)}`;
      
      const searchRes = await fetch(targetEndpoint, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9"
        }
      });

      const rawText = await searchRes.text();
      let searchData;
      try {
        searchData = JSON.parse(rawText);
      } catch (e) {
        // Fallback if API returned wrapped JSON
        const clean = rawText.substring(rawText.indexOf("{"), rawText.lastIndexOf("}") + 1);
        searchData = JSON.parse(clean);
      }

      const rawSongs = searchData?.songs?.data || [];
      if (!rawSongs.length) {
        return new Response(JSON.stringify({ tracks: [] }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const top5 = rawSongs.slice(0, 5);
      const pids = top5.map(s => s.id).join(",");

      // Fetch detail payloads for streams
      const detailsEndpoint = `https://www.jiosaavn.com/api.php?__call=song.getDetails&cc=in&_marker=0&_format=json&pids=${pids}`;
      const detailsRes = await fetch(detailsEndpoint, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        }
      });

      const detailsData = await detailsRes.json();
      const tracks = [];

      for (const item of top5) {
        const full = detailsData[item.id];
        if (!full) continue;

        let mediaStream = full.media_preview_url || "";
        if (mediaStream.includes("preview.saavncdn.com")) {
          mediaStream = mediaStream
            .replace("preview.saavncdn.com", "aac.saavn.cdn.jio.com")
            .replace("_96_p.mp4", "_160.mp4");
        }

        if (!mediaStream) continue;

        tracks.push({
          id: item.id,
          title: cleanHtmlEntities(item.title || "Unknown Track"),
          artist: cleanHtmlEntities(item.more_info?.primary_artists || item.description || "Various Artists"),
          album: cleanHtmlEntities(item.more_info?.album || ""),
          image: item.image ? item.image.replace("150x150", "250x250") : "",
          duration: formatSecondsToTime(full.duration || item.more_info?.duration || 0),
          streamUrl: mediaStream
        });
      }

      return new Response(JSON.stringify({ tracks }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ tracks: [], error: err.message }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }

  // =========================================================================
  // 2. STREAM RELAY: MASKS AUDIO CDN FROM ISP & SOPHOS
  // =========================================================================
  if (mode === "stream") {
    const rawTarget = url.searchParams.get("url");
    if (!rawTarget) {
      return new Response("Missing target stream parameter", { status: 400 });
    }

    try {
      const targetUrl = decodeURIComponent(rawTarget);
      const range = request.headers.get("Range");

      const fetchHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://www.jiosaavn.com/",
        "Accept": "*/*"
      };
      if (range) fetchHeaders["Range"] = range;

      const upstreamRes = await fetch(targetUrl, {
        headers: fetchHeaders
      });

      const responseHeaders = new Headers({
        ...corsHeaders,
        "Content-Type": "audio/mp4",
        "Accept-Ranges": "bytes"
      });

      if (upstreamRes.headers.has("Content-Length")) {
        responseHeaders.set("Content-Length", upstreamRes.headers.get("Content-Length"));
      }
      if (upstreamRes.headers.has("Content-Range")) {
        responseHeaders.set("Content-Range", upstreamRes.headers.get("Content-Range"));
      }

      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: responseHeaders
      });
    } catch (streamErr) {
      return new Response("Proxy relay timed out", { status: 502 });
    }
  }

  return new Response("Invalid mode", { status: 400 });
}

function cleanHtmlEntities(str) {
  return str.replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&#039;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>');
}

function formatSecondsToTime(sec) {
  const total = parseInt(sec, 10);
  if (isNaN(total) || total <= 0) return "--:--";
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}
