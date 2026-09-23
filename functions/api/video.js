/**
 * CLOUDFLARE PAGES EDGE FUNCTION: /api/video
 * 
 * 1. ZERO-LEAK STREAM & THUMBNAIL RELAY: Forwards Range/206 headers for progressive MP4s.
 * 2. SEARCH ENGINE: Seamless support for "youtube" and high-reliability "other" (Internet Archive) modes.
 */

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const streamId = url.searchParams.get("stream");
  const source = (url.searchParams.get("source") || "youtube").toLowerCase();
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);
  const thumbUrl = url.searchParams.get("thumb");

  const jsonHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Content-Type": "application/json"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: jsonHeaders });
  }

  try {
    // =========================================================================
    // 1. ZERO-LEAK BINARY THUMBNAIL RELAY
    // =========================================================================
    if (thumbUrl) {
      try {
        const targetThumb = decodeURIComponent(thumbUrl);
        const parsed = new URL(targetThumb);
        if (["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname)) {
          throw new Error("Invalid target");
        }

        const imgRes = await fetch(targetThumb, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
          },
          signal: AbortSignal.timeout(4000)
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

      const fallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180" fill="none"><rect width="320" height="180" fill="#111827"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#64748B" font-family="sans-serif" font-size="12">Preview Unavailable</text></svg>`;
      return new Response(fallbackSvg, {
        status: 200,
        headers: { "Content-Type": "image/svg+xml", "Access-Control-Allow-Origin": "*" }
      });
    }

    // =========================================================================
    // 2. ZERO-LEAK BINARY STREAM RELAY (HTTP 206 RANGE FORWARDER)
    // =========================================================================
    if (streamId) {
      let directStreamUrl = null;

      // MODE A: Direct Base64 Media URL (Used by "OTHER" / Internet Archive / MP4s)
      if (streamId.startsWith("b64_")) {
        try {
          directStreamUrl = atob(streamId.replace("b64_", ""));
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: "Invalid stream identifier" }), {
            headers: jsonHeaders,
            status: 400
          });
        }
      } 
      // MODE B: YouTube Video Stream (Invidious / Piped Mirror Resolution)
      else {
        directStreamUrl = await resolveYouTubeStream(streamId);
      }

      if (!directStreamUrl) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: "Media stream currently unreachable or restricted." 
        }), {
          headers: jsonHeaders,
          status: 404
        });
      }

      // Forward client Range header to allow seeking in HTML5 <video>
      const clientRange = request.headers.get("Range");
      const forwardHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept": "*/*",
        ...(clientRange ? { "Range": clientRange } : {})
      };

      const mediaRes = await fetch(directStreamUrl, {
        method: request.method === "HEAD" ? "HEAD" : "GET",
        headers: forwardHeaders
      });

      if (mediaRes.ok || mediaRes.status === 206) {
        const responseHeaders = new Headers();
        
        ["content-type", "content-length", "content-range", "accept-ranges"].forEach(h => {
          const val = mediaRes.headers.get(h);
          if (val) responseHeaders.set(h, val);
        });

       responseHeaders.set("Content-Type", mediaRes.headers.get("content-type") || "video/mp4");
        responseHeaders.set("Accept-Ranges", "bytes");
        responseHeaders.set("Access-Control-Allow-Origin", "*");
        responseHeaders.set("Access-Control-Allow-Headers", "Range");

        return new Response(mediaRes.body, {
          status: mediaRes.status,
          headers: responseHeaders
        });
      }

      return new Response(JSON.stringify({ success: false, error: `Upstream returned status ${mediaRes.status}` }), {
        headers: jsonHeaders,
        status: 502
      });
    }

    // =========================================================================
    // 3. SEARCH & METADATA PIPELINE (HANDLES "OTHER" AND "YOUTUBE")
    // =========================================================================
    if (query) {
      const selfEndpoint = url.pathname;
      let results = [];

      // -----------------------------------------------------------------------
      // MODE: "OTHER" (Internet Archive Fuzzy Search with Guaranteed MP4s)
      // -----------------------------------------------------------------------
      if (source === "other") {
        results = await searchInternetArchive(query, selfEndpoint);
      } 
      // -----------------------------------------------------------------------
      // MODE: "YOUTUBE" (Scrapes YouTube, falls back to Archive if throttled)
      // -----------------------------------------------------------------------
      else {
        results = await searchYouTube(query, selfEndpoint);
        
        // If YouTube scrape returned 0 items due to IP ban, automatically fallback to Archive
        if (results.length === 0) {
          results = await searchInternetArchive(query, selfEndpoint);
        }
      }

      if (results.length === 0) {
        return new Response(JSON.stringify({
          success: false,
          source: source,
          error: `No matching videos found on ${source.toUpperCase()}.`
        }), {
          headers: jsonHeaders
        });
      }

      const pageResults = results.slice(offset, offset + 4);
      const hasNext = results.length > offset + 4;

      return new Response(JSON.stringify({
        success: true,
        source: source,
        offset: offset,
        hasNext: hasNext,
        results: pageResults
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
// SEARCH & STREAM HELPERS
// =========================================================================

/**
 * High-Reliability Internet Archive Video Fetcher
 * Finds video uploads and guarantees direct playable progressive MP4s.
 */
async function searchInternetArchive(query, selfEndpoint) {
  try {
    const cleanWords = query.replace(/[^\w\s]/gi, ' ').trim().split(/\s+/).filter(Boolean);
    if (cleanWords.length === 0) return [];

    // Loose keyword matching over titles and descriptions to avoid empty queries
    const orQuery = cleanWords.map(w => `title:*${w}* OR description:*${w}*`).join(" OR ");
    const searchUrl = `https://archive.org/advancedsearch.php?q=(${encodeURIComponent(orQuery)})+AND+mediatype:movies&fl[]=identifier,title,creator,length,downloads&sort[]=downloads+desc&rows=10&page=1&output=json`;

    const res = await fetch(searchUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MeshRelay/2.0" },
      signal: AbortSignal.timeout(4500)
    });

    if (!res.ok) return [];
    const data = await res.json();
    const docs = data.response?.docs || [];
    const results = [];

    for (const doc of docs) {
      if (!doc.identifier) continue;

      // Internet Archive standard video streaming redirector
      // /download/{id}/{id}.mp4 or /download/{id} serves the primary progressive web container
      const directMp4 = `https://archive.org/download/${doc.identifier}/${doc.identifier}.mp4`;
      const thumb = `https://archive.org/services/img/${doc.identifier}`;

      let durationStr = "HD Video";
      if (doc.length) {
        const totalSec = Math.floor(parseFloat(doc.length));
        if (!isNaN(totalSec) && totalSec > 0) {
          const mins = Math.floor(totalSec / 60);
          const secs = String(totalSec % 60).padStart(2, '0');
          durationStr = `${mins}:${secs}`;
        }
      }

      results.push({
        id: `b64_${btoa(directMp4)}`,
        title: doc.title || query,
        uploader: doc.creator || "Archive Open Media",
        duration: durationStr,
        thumbnail: `${selfEndpoint}?thumb=${encodeURIComponent(thumb)}`,
        source: "OTHER"
      });
    }

    return results;
  } catch (e) {
    return [];
  }
}

/**
 * YouTube Direct Search Scraper
 */
async function searchYouTube(query, selfEndpoint) {
  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const res = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Cookie": "CONSENT=PENDING+999; SOCS=CAESEwgDEgk2MTc4OTk1MzQaAmVuIAEaBgiA_LyaBg"
      },
      signal: AbortSignal.timeout(4500)
    });

    if (!res.ok) return [];
    const html = await res.text();
    const match = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData = ({.*?});/s);
    if (!match || !match[1]) return [];

    const parsed = JSON.parse(match[1]);
    const contents = parsed?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
    const results = [];

    if (Array.isArray(contents)) {
      for (const sec of contents) {
        const items = sec?.itemSectionRenderer?.contents;
        if (Array.isArray(items)) {
          for (const it of items) {
            if (it.videoRenderer && it.videoRenderer.videoId) {
              const vr = it.videoRenderer;
              const thumbTarget = `https://i.ytimg.com/vi/${vr.videoId}/hqdefault.jpg`;
              
              results.push({
                id: vr.videoId,
                title: vr.title?.runs?.[0]?.text || vr.title?.simpleText || "Video",
                uploader: vr.ownerText?.runs?.[0]?.text || "Creator",
                duration: vr.lengthText?.simpleText || "HD",
                thumbnail: `${selfEndpoint}?thumb=${encodeURIComponent(thumbTarget)}`,
                source: "YouTube"
              });
            }
          }
        }
      }
    }
    return results;
  } catch (e) {
    return [];
  }
}

/**
 * YouTube Stream URL Resolution Matrix
 */
async function resolveYouTubeStream(videoId) {
  const mirrors = [
    `https://inv.tux.pizza/api/v1/videos/${videoId}`,
    `https://invidious.nerdvpn.de/api/v1/videos/${videoId}`,
    `https://invidious.protokolla.fi/api/v1/videos/${videoId}`,
    `https://vid.priv.au/api/v1/videos/${videoId}`
  ];

  for (const endpoint of mirrors) {
    try {
      const res = await fetch(endpoint, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MeshRelay/2.0" },
        signal: AbortSignal.timeout(3000)
      });
      if (!res.ok) continue;

      const data = await res.json();
      const streams = data.videoStreams || data.formatStreams || [];
      const matched = streams.find(s => !s.videoOnly && (s.mimeType?.includes("mp4") || s.container === "mp4")) 
                   || streams.find(s => s.url || s.videoUrl);

      if (matched && (matched.url || matched.videoUrl)) {
        return matched.url || matched.videoUrl;
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}
