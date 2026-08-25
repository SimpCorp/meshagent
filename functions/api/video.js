// Verified Active Invidious & Piped Instances with dedicated format handlers
const INVIDIOUS_INSTANCES = [
  "https://invidious.drgns.space",
  "https://vid.puffyan.us",
  "https://invidious.flokinet.to",
  "https://inv.riverside.rocks",
  "https://invidious.privacydev.net"
];

const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://api.piped.privacydev.net",
  "https://piped-api.lunar.icu"
];

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const query = url.searchParams.get("q");
  const videoId = url.searchParams.get("id");

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // ==========================================
  // 1. VIDEO SEARCH
  // ==========================================
  if (query) {
    // Strategy A: Try Invidious Instances (/api/v1/search)
    for (const inst of INVIDIOUS_INSTANCES) {
      try {
        const searchUrl = `${inst}/api/v1/search?q=${encodeURIComponent(query)}&type=video`;
        const res = await fetch(searchUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
          signal: AbortSignal.timeout(3500)
        });

        if (!res.ok) continue;
        const data = await res.json();

        if (Array.isArray(data) && data.length > 0) {
          const top3 = data
            .filter(v => v.videoId && v.title)
            .slice(0, 3)
            .map(v => ({
              id: v.videoId,
              title: v.title,
              uploader: v.author || "YouTube Creator",
              duration: v.lengthSeconds ? formatDuration(v.lengthSeconds) : "Video",
              thumbnail: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
              instance: inst
            }));

          if (top3.length > 0) {
            return new Response(JSON.stringify({ success: true, results: top3 }), { headers: corsHeaders });
          }
        }
      } catch (e) {
        continue;
      }
    }

    // Strategy B: Fallback to Piped Instances (/search)
    for (const inst of PIPED_INSTANCES) {
      try {
        const searchUrl = `${inst}/search?q=${encodeURIComponent(query)}&filter=videos`;
        const res = await fetch(searchUrl, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(3500)
        });

        if (!res.ok) continue;
        const data = await res.json();
        const items = data.items || data;

        if (Array.isArray(items) && items.length > 0) {
          const top3 = items
            .filter(v => (v.url || v.id) && (v.title || v.name))
            .slice(0, 3)
            .map(v => {
              const id = v.url ? v.url.replace("/watch?v=", "") : v.id;
              return {
                id: id,
                title: v.title || v.name,
                uploader: v.uploaderName || "YouTube Creator",
                duration: v.duration ? formatDuration(v.duration) : "Video",
                thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
                instance: inst
              };
            });

          if (top3.length > 0) {
            return new Response(JSON.stringify({ success: true, results: top3 }), { headers: corsHeaders });
          }
        }
      } catch (e) {
        continue;
      }
    }

    return new Response(JSON.stringify({ success: false, error: "Search backend unreachable. Try again in a moment." }), { headers: corsHeaders });
  }

  // ==========================================
  // 2. DIRECT STREAM URL EXTRACTION
  // ==========================================
  if (videoId) {
    // Strategy A: Direct Invidious Media Stream
    for (const inst of INVIDIOUS_INSTANCES) {
      try {
        const infoUrl = `${inst}/api/v1/videos/${encodeURIComponent(videoId)}`;
        const res = await fetch(infoUrl, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(3500)
        });

        if (!res.ok) continue;
        const data = await res.json();

        // FormatFormats: Look for combined video+audio streams (itag 18 = 360p mp4, itag 22 = 720p mp4)
        const formatStreams = data.formatStreams || [];
        const combinedMp4 = formatStreams.find(s => s.itag === "22" || s.qualityLabel === "720p") || formatStreams[0];

        if (combinedMp4 && combinedMp4.url) {
          return new Response(JSON.stringify({ success: true, streamUrl: combinedMp4.url }), { headers: corsHeaders });
        }

        // Direct proxied fallback stream
        const fallbackUrl = `${inst}/latest_version?id=${encodeURIComponent(videoId)}&itag=18`;
        return new Response(JSON.stringify({ success: true, streamUrl: fallbackUrl }), { headers: corsHeaders });
      } catch (e) {
        continue;
      }
    }

    // Strategy B: Piped Stream Extraction Fallback
    for (const inst of PIPED_INSTANCES) {
      try {
        const streamUrl = `${inst}/streams/${encodeURIComponent(videoId)}`;
        const res = await fetch(streamUrl, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(3500)
        });

        if (!res.ok) continue;
        const data = await res.json();

        const videoStreams = (data.videoStreams || []).filter(s => !s.videoOnly && s.mimeType?.includes("mp4"));
        const bestStream = videoStreams.find(s => s.quality === "720p") || videoStreams[0];

        if (bestStream && bestStream.url) {
          return new Response(JSON.stringify({ success: true, streamUrl: bestStream.url }), { headers: corsHeaders });
        }
      } catch (e) {
        continue;
      }
    }

    return new Response(JSON.stringify({ success: false, error: "Stream link unavailable." }), { headers: corsHeaders });
  }

  return new Response(JSON.stringify({ error: "Missing query parameter 'q' or 'id'" }), { headers: corsHeaders, status: 400 });
}

function formatDuration(seconds) {
  if (typeof seconds === "string") return seconds;
  const num = parseInt(seconds, 10);
  if (isNaN(num)) return "Video";
  const mins = Math.floor(num / 60);
  const secs = num % 60;
  return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
}
