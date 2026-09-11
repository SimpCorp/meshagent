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
  // 1. SEARCH ENDPOINT: PROXIES QUERY SERVER-TO-SERVER
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
      const jamendoUrl = `https://api.jamendo.com/v3.0/tracks/?client_id=56d30c95&format=json&limit=3&namesearch=${encodeURIComponent(query)}&include=musicinfo`;

      const searchRes = await fetch(jamendoUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "application/json"
        },
        signal: AbortSignal.timeout(4000)
      });

      if (!searchRes.ok) throw new Error("Search upstream failure");
      const data = await searchRes.json();

      const tracks = (data.results || []).slice(0, 3).map(item => ({
        id: item.id,
        title: item.name,
        artist: item.artist_name,
        duration: formatSecToMin(item.duration),
        streamUrl: item.audio
      }));

      return new Response(JSON.stringify({ tracks }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ tracks: [] }), {
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
        "Accept": "*/*"
      };
      if (range) fetchHeaders["Range"] = range;

      const upstreamRes = await fetch(targetUrl, {
        headers: fetchHeaders,
        signal: AbortSignal.timeout(6000)
      });

      const responseHeaders = new Headers({
        ...corsHeaders,
        "Content-Type": "application/octet-stream", // Masks explicit audio/mpeg sniffing
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

  return new Response("Invalid request mode", { status: 400 });
}

function formatSecToMin(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}
