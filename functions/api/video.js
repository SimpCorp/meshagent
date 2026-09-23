/**
 * CLOUDFLARE PAGES EDGE FUNCTION: /api/video
 * 
 * 1. ZERO-LEAK STREAM & THUMBNAIL RELAY: Streams media bytes with Range/206 headers intact.
 * 2. AGGRESSIVE MULTI-SOURCE SEARCH: Aggregates YouTube, Internet Archive (Direct MP4s),
 *    and Open Media Repositories with automatic keyword relaxation.
 */

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const streamId = url.searchParams.get("stream");
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
    // 1. ZERO-LEAK BINARY THUMBNAIL PROXY
    // =========================================================================
    if (thumbUrl) {
      try {
        const targetThumb = decodeURIComponent(thumbUrl);
        const parsed = new URL(targetThumb);
        if (["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname)) {
          throw new Error("Invalid host");
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
      
      // Inline dark placeholder thumbnail if source image is unreachable
      const fallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180" fill="none"><rect width="320" height="180" fill="#111827"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#64748B" font-family="sans-serif" font-size="12">Preview Unavailable</text></svg>`;
      return new Response(fallbackSvg, {
        status: 200,
        headers: { "Content-Type": "image/svg+xml", "Access-Control-Allow-Origin": "*" }
      });
    }

    // =========================================================================
    // 2. ZERO-LEAK BINARY VIDEO STREAM RELAY (HTTP 206 RANGE FORWARDER)
    // =========================================================================
    if (streamId) {
      let directStreamUrl = null;

      // TYPE A: Base64-encoded direct media URL (Internet Archive, Open MP4s)
      if (streamId.startsWith("b64_")) {
        try {
          directStreamUrl = atob(streamId.replace("b64_", ""));
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: "Malformed media identifier" }), {
            headers: jsonHeaders,
            status: 400
          });
        }
      } 
      // TYPE B: YouTube video ID resolution matrix
      else {
        directStreamUrl = await resolveYouTubeStream(streamId);
      }

      if (!directStreamUrl) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: "Stream source offline or restricted upstream." 
        }), {
          headers: jsonHeaders,
          status: 404
        });
      }

      // Forward client Range request for native HTML5 seek/scrub support
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
        responseHeaders.set("Access-Control-Allow-Origin": "*");
        responseHeaders.set("Access-Control-Allow-Headers", "Range");

        return new Response(mediaRes.body, {
          status: mediaRes.status,
          headers: responseHeaders
        });
      }

      return new Response(JSON.stringify({ success: false, error: `Upstream returned HTTP ${mediaRes.status}` }), {
        headers: jsonHeaders,
        status: 502
      });
    }

    // =========================================================================
    // 3. AGGRESSIVE MULTI-SOURCE SEARCH & METADATA AGGREGATOR
    // =========================================================================
    if (query) {
      const selfEndpoint = url.pathname;

      // Launch multi-repository search concurrently
      const [ytResults, archiveResults, wikiResults] = await Promise.all([
        searchYouTube(query, selfEndpoint),
        searchInternetArchive(query, selfEndpoint),
        searchWikimediaVideo(query, selfEndpoint)
      ]);

      // Direct MP4 sources play reliably 100% of the time. Interleave them.
      let combined = [];

      // Interleave results: Archive (Reliable MP4) -> YouTube -> Wiki
      const maxLen = Math.max(archiveResults.length, ytResults.length, wikiResults.length);
      for (let i = 0; i < maxLen; i++) {
        if (archiveResults[i]) combined.push(archiveResults[i]);
        if (ytResults[i]) combined.push(ytResults[i]);
        if (wikiResults[i]) combined.push(wikiResults[i]);
      }

      // If specific search failed, perform fuzzy keyword relaxation
      if (combined.length === 0) {
        const relaxedKeywords = query.split(/\s+/).slice(0, 2).join(" ");
        if (relaxedKeywords && relaxedKeywords !== query) {
          const fallbackArchive = await searchInternetArchive(relaxedKeywords, selfEndpoint);
          combined = fallbackArchive;
        }
      }

      if (combined.length === 0) {
        return new Response(JSON.stringify({
          success: false,
          error: "No streaming media found matching your query."
        }), {
          headers: jsonHeaders
        });
      }

      const pageResults = combined.slice(offset, offset + 4);
      const hasNext = combined.length > offset + 4;

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

    return new Response(JSON.stringify({ success: false, error: "Missing query or stream parameter" }), {
      headers: jsonHeaders,
      status: 400
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: "Worker exception: " + err.message }), {
      headers: jsonHeaders,
      status: 500
    });
  }
}

// =========================================================================
// STREAM RESOLVERS & REPOSITORY FETCHERS
// =========================================================================

/**
 * YouTube Stream URL Resolution Matrix
 */
async function resolveYouTubeStream(videoId) {
  const mirrors = [
    `https://inv.tux.pizza/api/v1/videos/${videoId}`,
    `https://invidious.nerdvpn.de/api/v1/videos/${videoId}`,
    `https://invidious.protokolla.fi/api/v1/videos/${videoId}`,
    `https://vid.priv.au/api/v1/videos/${videoId}`,
    `https://pipedapi.kavin.rocks/streams/${videoId}`
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
      
      // Look for progressive MP4 streams that contain both video and audio
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

/**
 * Engine 1: Internet Archive (Direct MP4 Streams - Game Trailers, Media, Clips)
 */
async function searchInternetArchive(query, selfEndpoint) {
  try {
    const cleanQ = encodeURIComponent(query.replace(/[^\w\s]/gi, ''));
    const iaUrl = `https://archive.org/advancedsearch.php?q=${cleanQ}+AND+mediatype:movies&fl[]=identifier,title,creator,length,description&sort[]=downloads+desc&rows=8&page=1&output=json`;
    
    const res = await fetch(iaUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MeshRelay/2.0" },
      signal: AbortSignal.timeout(4000)
    });

    if (!res.ok) return [];
    const data = await res.json();
    const docs = data.response?.docs || [];
    const results = [];

    for (const doc of docs) {
      if (!doc.identifier) continue;
      
      // Direct high-speed MP4 link from Archive.org's global storage servers
      const directMp4 = `https://archive.org/download/${doc.identifier}/${doc.identifier}.mp4`;
      const thumb = `https://archive.org/services/img/${doc.identifier}`;

      results.push({
        id: `b64_${btoa(directMp4)}`,
        title: doc.title || query,
        uploader: doc.creator || "Archive Open Media",
        duration: doc.length ? `${Math.floor(doc.length / 60)}:${String(Math.floor(doc.length % 60)).padStart(2, '0')}` : "Stream",
        thumbnail: `${selfEndpoint}?thumb=${encodeURIComponent(thumb)}`,
        source: "Archive.org (Direct MP4)"
      });
    }

    return results;
  } catch (e) {
    return [];
  }
}

/**
 * Engine 2: YouTube Search Scraper
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
 * Engine 3: Wikimedia Commons Video Search (Public Domain & Open Video Clones)
 */
async function searchWikimediaVideo(query, selfEndpoint) {
  try {
    const wikiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(query)}+filetype:video&gsrlimit=4&prop=imageinfo&iiprop=url|size|mime&format=json&origin=*`;
    const res = await fetch(wikiUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MeshRelay/2.0" },
      signal: AbortSignal.timeout(3500)
    });

    if (!res.ok) return [];
    const data = await res.json();
    const pages = data?.query?.pages || {};
    const results = [];

    for (const page of Object.values(pages)) {
      const info = page.imageinfo?.[0];
      if (info && info.url && (info.mime?.includes("webm") || info.mime?.includes("mp4") || info.mime?.includes("ogg"))) {
        results.push({
          id: `b64_${btoa(info.url)}`,
          title: (page.title || "Video").replace(/^File:/i, ""),
          uploader: "Wikimedia Video",
          duration: "Open Media",
          thumbnail: `${selfEndpoint}?thumb=${encodeURIComponent(info.thumburl || info.url)}`,
          source: "Wikimedia"
        });
      }
    }
    return results;
  } catch (e) {
    return [];
  }
}
