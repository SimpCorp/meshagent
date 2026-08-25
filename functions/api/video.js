// List of public, reliable Piped / Invidious instances
const INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://api.piped.privacydev.net",
  "https://piped-api.lunar.icu",
  "https://api.invidious.io"
];

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const query = url.searchParams.get("q");
  const videoId = url.searchParams.get("id");

  // Headers to allow internal calls & prevent caching issues
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // --- MODE 1: SEARCH VIDEOS ---
  if (query) {
    for (const instance of INSTANCES) {
      try {
        const searchUrl = `${instance}/search?q=${encodeURIComponent(query)}&filter=videos`;
        const res = await fetch(searchUrl, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(3500)
        });

        if (!res.ok) continue;

        const data = await res.json();
        const items = data.items || data;

        // Filter and grab top 3 results
        const top3 = items
          .filter(v => v.url && (v.title || v.name))
          .slice(0, 3)
          .map(v => {
            const id = v.url ? v.url.replace("/watch?v=", "") : v.id;
            return {
              id: id,
              title: v.title || v.name,
              uploader: v.uploaderName || v.author || "YouTube Creator",
              duration: v.duration ? formatDuration(v.duration) : "Video",
              thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
            };
          });

        if (top3.length > 0) {
          return new Response(JSON.stringify({ success: true, results: top3 }), { headers: corsHeaders });
        }
      } catch (err) {
        continue; // Try next instance if timeout/failed
      }
    }

    return new Response(JSON.stringify({ success: false, error: "Unable to retrieve search results. Try a different query." }), { headers: corsHeaders });
  }

  // --- MODE 2: FETCH DIRECT STREAM URL ---
  if (videoId) {
    for (const instance of INSTANCES) {
      try {
        const streamUrl = `${instance}/streams/${encodeURIComponent(videoId)}`;
        const res = await fetch(streamUrl, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(4000)
        });

        if (!res.ok) continue;

        const data = await res.json();
        
        // Find best MP4 stream with both video & audio (usually 720p or 360p)
        const videoStreams = (data.videoStreams || []).filter(s => !s.videoOnly && s.mimeType?.includes("mp4"));
        const bestStream = videoStreams.find(s => s.quality === "720p") || videoStreams[0];

        if (bestStream && bestStream.url) {
          return new Response(JSON.stringify({ success: true, streamUrl: bestStream.url }), { headers: corsHeaders });
        } else if (data.hls) {
          return new Response(JSON.stringify({ success: true, streamUrl: data.hls }), { headers: corsHeaders });
        }
      } catch (err) {
        continue;
      }
    }

    return new Response(JSON.stringify({ success: false, error: "Stream link unavailable." }), { headers: corsHeaders });
  }

  return new Response(JSON.stringify({ error: "Missing query parameter 'q' or 'id'" }), { headers: corsHeaders, status: 400 });
}

function formatDuration(seconds) {
  if (typeof seconds === "string") return seconds;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
}
