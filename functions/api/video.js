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
    // --- 1. PROXIED THUMBNAIL (0 Client Leaks) ---
    if (thumbId) {
      try {
        const imgRes = await fetch(`https://i.ytimg.com/vi/${encodeURIComponent(thumbId)}/hqdefault.jpg`, {
          headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X)" },
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

    // --- 2. PROXIED VIDEO STREAM PIPELINE ---
    if (streamId) {
      const videoId = encodeURIComponent(streamId);
      let targetStreamUrl = null;

      // InnerTube Client Profiles Matrix
      const clientPayloads = [
        {
          client: {
            clientName: "IOS",
            clientVersion: "19.29.1",
            deviceMake: "Apple",
            deviceModel: "iPhone14,3",
            osName: "iOS",
            osVersion: "16.5.0.20F66",
            hl: "en",
            gl: "US"
          }
        },
        {
          client: {
            clientName: "ANDROID",
            clientVersion: "19.29.35",
            androidSdkVersion: 33,
            hl: "en",
            gl: "US"
          }
        },
        {
          client: {
            clientName: "TVHTML5_SIMPLY_EMBEDDED",
            clientVersion: "2.0",
            hl: "en",
            gl: "US"
          },
          thirdParty: {
            embedUrl: "https://www.youtube.com"
          }
        }
      ];

      // Step A: Extract Direct Progressive MP4 from InnerTube
      for (const payload of clientPayloads) {
        try {
          const innertubeRes = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": payload.client.clientName === "IOS" 
                ? "com.google.ios.youtube/19.29.1 (iPhone14,3; U; CPU iOS 16_5 like Mac OS X; en_US)" 
                : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              "X-YouTube-Client-Name": payload.client.clientName === "IOS" ? "5" : (payload.client.clientName === "ANDROID" ? "3" : "85"),
              "X-YouTube-Client-Version": payload.client.clientVersion
            },
            body: JSON.stringify({
              context: { client: payload.client, ...(payload.thirdParty ? { thirdParty: payload.thirdParty } : {}) },
              videoId: videoId,
              contentCheckOk: true,
              racyCheckOk: true
            }),
            signal: AbortSignal.timeout(4500)
          });

          if (!innertubeRes.ok) continue;

          const data = await innertubeRes.json();
          const progressiveFormats = data?.streamingData?.formats || [];
          const adaptiveFormats = data?.streamingData?.adaptiveFormats || [];

          // 1st Priority: Progressive MP4 (Combined Audio + Video, no cipher)
          const progressiveMp4 = progressiveFormats.find(f => f.url && f.mimeType?.includes("video/mp4"));
          // 2nd Priority: Any format with direct URL
          const fallbackFormat = progressiveFormats.find(f => f.url) || adaptiveFormats.find(f => f.url && f.mimeType?.includes("video/mp4"));

          const chosen = progressiveMp4 || fallbackFormat;
          if (chosen && chosen.url) {
            targetStreamUrl = chosen.url;
            break;
          }
        } catch (err) {
          continue;
        }
      }

      // Step B: Serverless Public Edge Fallbacks if InnerTube is signature-locked
      if (!targetStreamUrl) {
        const fallbackRelays = [
          `https://api.piped.privacydev.net/streams/${videoId}`,
          `https://pipedapi.kavin.rocks/streams/${videoId}`,
          `https://invidious.nerdvpn.de/api/v1/videos/${videoId}`,
          `https://yt.artemislena.eu/api/v1/videos/${videoId}`
        ];

        for (const relay of fallbackRelays) {
          try {
            const relayRes = await fetch(relay, {
              headers: { "User-Agent": "Mozilla/5.0" },
              signal: AbortSignal.timeout(3500)
            });
            if (!relayRes.ok) continue;
            const relayData = await relayRes.json();
            
            const streams = relayData.videoStreams || relayData.formatStreams || [];
            const mp4Stream = streams.find(s => !s.videoOnly && (s.mimeType?.includes("mp4") || s.container === "mp4")) || streams[0];
            
            if (mp4Stream && (mp4Stream.url || mp4Stream.videoUrl)) {
              targetStreamUrl = mp4Stream.url || mp4Stream.videoUrl;
              break;
            }
          } catch (e) {
            continue;
          }
        }
      }

      if (!targetStreamUrl) {
        return new Response(JSON.stringify({ success: false, error: "Stream unavailable from upstream media sources." }), {
          headers: jsonHeaders,
          status: 404
        });
      }

      // Step C: Pipe Video Bytes with HTTP Byte-Range Negotiations
      const rangeHeader = request.headers.get("Range");
      const upstreamHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Referer": "https://www.youtube.com/",
        ...(rangeHeader ? { "Range": rangeHeader } : {})
      };

      const byteRes = await fetch(targetStreamUrl, { headers: upstreamHeaders });

      if (byteRes.ok || byteRes.status === 206) {
        const respHeaders = new Headers();
        
        // Pass essential media transport headers
        ["content-type", "content-length", "content-range", "accept-ranges"].forEach(h => {
          const val = byteRes.headers.get(h);
          if (val) respHeaders.set(h, val);
        });

        respHeaders.set("Content-Type", "video/mp4");
        respHeaders.set("Accept-Ranges", "bytes");
        respHeaders.set("Access-Control-Allow-Origin", "*");
        respHeaders.set("Access-Control-Allow-Headers", "Range");

        return new Response(byteRes.body, {
          status: byteRes.status,
          headers: respHeaders
        });
      }

      return new Response(JSON.stringify({ success: false, error: `Upstream media server returned HTTP ${byteRes.status}` }), {
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
        return new Response(JSON.stringify({ success: false, error: `Search upstream error: ${searchRes.status}` }), {
          headers: jsonHeaders
        });
      }

      const html = await searchRes.text();
      const match = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData = ({.*?});/s);

      if (!match || !match[1]) {
        return new Response(JSON.stringify({ success: false, error: "Failed to parse search metadata." }), {
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
        return new Response(JSON.stringify({ success: false, error: "No video results found." }), { headers: jsonHeaders });
      }
    }

    return new Response(JSON.stringify({ success: false, error: "Missing required parameter" }), {
      headers: jsonHeaders,
      status: 400
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: "Edge runtime exception: " + err.message }), {
      headers: jsonHeaders,
      status: 500
    });
  }
}
