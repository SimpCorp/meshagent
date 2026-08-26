export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const query = url.searchParams.get("q");
  const streamId = url.searchParams.get("stream");
  const source = url.searchParams.get("source") || "youtube"; // "youtube" | "other"
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
        const imgRes = await fetch(targetThumb, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
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
      return new Response(null, { status: 404 });
    }

    // =========================================================================
    // 2. ZERO-LEAK BINARY STREAM RELAY (HTTP 206 RANGE FORWARDER)
    // =========================================================================
    if (streamId) {
      let directStreamUrl = null;

      // Type A: Direct Base64 Encoded Media URL (For "OTHER" platforms)
      if (streamId.startsWith("b64_")) {
        try {
          directStreamUrl = atob(streamId.replace("b64_", ""));
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: "Invalid stream token" }), {
            headers: jsonHeaders,
            status: 400
          });
        }
      } 
      // Type B: YouTube Video Stream (Edge Multi-Instance Resolution Matrix)
      else {
        const videoId = streamId;

        // Instance Fallback Matrix to bypass IP rate-limiting & cipher blocks
        const publicMirrors = [
          `https://api.piped.privacydev.net/streams/${videoId}`,
          `https://pipedapi.kavin.rocks/streams/${videoId}`,
          `https://invidious.nerdvpn.de/api/v1/videos/${videoId}`,
          `https://yt.artemislena.eu/api/v1/videos/${videoId}`,
          `https://inv.tux.pizza/api/v1/videos/${videoId}`
        ];

        for (const mirror of publicMirrors) {
          try {
            const mRes = await fetch(mirror, {
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
              },
              signal: AbortSignal.timeout(3500)
            });

            if (!mRes.ok) continue;

            const mData = await mRes.json();
            const streams = mData.videoStreams || mData.formatStreams || [];

            // Select progressive MP4 stream with audio combined
            const matched = streams.find(s => !s.videoOnly && (s.mimeType?.includes("mp4") || s.container === "mp4")) || streams[0];
            
            if (matched && (matched.url || matched.videoUrl)) {
              directStreamUrl = matched.url || matched.videoUrl;
              break;
            }
          } catch (e) {
            continue;
          }
        }
      }

      if (!directStreamUrl) {
        return new Response(JSON.stringify({ success: false, error: "Media stream currently unavailable." }), {
          headers: jsonHeaders,
          status: 404
        });
      }

      // Forward HTTP Range headers to enable native HTML5 scrubbing and byte streaming
      const clientRange = request.headers.get("Range");
      const forwardHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        ...(clientRange ? { "Range": clientRange } : {})
      };

      const mediaRes = await fetch(directStreamUrl, {
        method: request.method === "HEAD" ? "HEAD" : "GET",
        headers: forwardHeaders
      });

      if (mediaRes.ok || mediaRes.status === 206) {
        const responseHeaders = new Headers();
        
        // Pass essential byte-range streaming headers
        ["content-type", "content-length", "content-range", "accept-ranges"].forEach(header => {
          const val = mediaRes.headers.get(header);
          if (val) responseHeaders.set(header, val);
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

      return new Response(JSON.stringify({ success: false, error: `Upstream gateway error: ${mediaRes.status}` }), {
        headers: jsonHeaders,
        status: 502
      });
    }

    // =========================================================================
    // 3. MULTI-ENGINE SEARCH & METADATA AGGREGATOR
    // =========================================================================
    if (query) {
      // -----------------------------------------------------------------------
      // MODE A: YOUTUBE ENGINE
      // -----------------------------------------------------------------------
      if (source === "youtube") {
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
          return new Response(JSON.stringify({ success: false, error: "Search upstream timeout" }), {
            headers: jsonHeaders
          });
        }

        const html = await searchRes.text();
        const match = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData = ({.*?});/s);

        if (!match || !match[1]) {
          return new Response(JSON.stringify({ success: false, error: "Failed to parse search metadata" }), {
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
                  const thumbTarget = `https://i.ytimg.com/vi/${vr.videoId}/hqdefault.jpg`;
                  
                  results.push({
                    id: vr.videoId,
                    title: vr.title?.runs?.[0]?.text || vr.title?.simpleText || "Video",
                    uploader: vr.ownerText?.runs?.[0]?.text || "Creator",
                    duration: vr.lengthText?.simpleText || "Video",
                    thumbnail: `/api/video?thumb=${encodeURIComponent(thumbTarget)}`,
                    source: "YouTube"
                  });
                }
              }
            }
          }
        }

        const pageResults = results.slice(offset, offset + 3);
        const hasNext = results.length > offset + 3;

        return new Response(JSON.stringify({
          success: true,
          source: "youtube",
          offset: offset,
          hasNext: hasNext,
          results: pageResults
        }), {
          headers: jsonHeaders
        });
      }

      // -----------------------------------------------------------------------
      // MODE B: "OTHER" ENGINE (Direct Open Libraries)
      // -----------------------------------------------------------------------
      if (source === "other") {
        let aggregatedOtherResults = [];

        // Internet Archive Open Video Library (Direct MP4 Streams)
        try {
          const iaRes = await fetch(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}+AND+mediatype:movies&fl[]=identifier,title,creator,length&sort[]=&rows=6&page=1&output=json`, {
            signal: AbortSignal.timeout(4000)
          });

          if (iaRes.ok) {
            const iaData = await iaRes.json();
            (iaData.response?.docs || []).forEach(doc => {
              const directMp4 = `https://archive.org/download/${doc.identifier}/${doc.identifier}.mp4`;
              const thumb = `https://archive.org/services/img/${doc.identifier}`;
              
              aggregatedOtherResults.push({
                id: `b64_${btoa(directMp4)}`,
                title: doc.title || "Archive Video",
                uploader: doc.creator || "Archive Library",
                duration: doc.length || "Stream",
                thumbnail: `/api/video?thumb=${encodeURIComponent(thumb)}`,
                source: "Archive.org"
              });
            });
          }
        } catch (e) {}

        const pageResults = aggregatedOtherResults.slice(offset, offset + 3);
        const hasNext = aggregatedOtherResults.length > offset + 3;

        return new Response(JSON.stringify({
          success: true,
          source: "other",
          offset: offset,
          hasNext: hasNext,
          results: pageResults
        }), {
          headers: jsonHeaders
        });
      }
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
