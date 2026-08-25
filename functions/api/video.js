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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Content-Type": "application/json"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: jsonHeaders });
  }

  try {
    // =========================================================================
    // 1. ZERO-LEAK PROXIED THUMBNAIL PIPE
    // =========================================================================
    if (thumbUrl) {
      try {
        const decodedThumb = decodeURIComponent(thumbUrl);
        const imgRes = await fetch(decodedThumb, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
          signal: AbortSignal.timeout(4000)
        });
        if (imgRes.ok) {
          const contentType = imgRes.headers.get("content-type") || "image/jpeg";
          return new Response(imgRes.body, {
            headers: {
              "Content-Type": contentType,
              "Cache-Control": "public, max-age=86400",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }
      } catch (e) {}
      return new Response(null, { status: 404 });
    }

    // =========================================================================
    // 2. UNIVERSAL ZERO-LEAK STREAM PROXY (HTTP 206 BYTE-RANGE FORWARDER)
    // =========================================================================
    if (streamId) {
      let resolvedDirectMediaUrl = null;

      // Type A: Direct Base64 Encoded Stream URL (Used for "OTHER" engine sources)
      if (streamId.startsWith("b64_")) {
        try {
          resolvedDirectMediaUrl = atob(streamId.replace("b64_", ""));
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: "Malformed stream token" }), { headers: jsonHeaders, status: 400 });
        }
      } 
      // Type B: YouTube Video ID (Comprehensive Extraction Matrix)
      else {
        const videoId = streamId;

        // Matrix Step 1: Direct InnerTube Embedded & Native Profiles
        const clientProfiles = [
          {
            client: { clientName: "IOS", clientVersion: "19.29.1", deviceMake: "Apple", deviceModel: "iPhone14,3", osName: "iOS", osVersion: "16.5.0.20F66", hl: "en", gl: "US" }
          },
          {
            client: { clientName: "TVHTML5_SIMPLY_EMBEDDED", clientVersion: "2.0", hl: "en", gl: "US" },
            thirdParty: { embedUrl: "https://www.youtube.com" }
          },
          {
            client: { clientName: "ANDROID", clientVersion: "19.29.35", androidSdkVersion: 33, hl: "en", gl: "US" }
          }
        ];

        for (const profile of clientProfiles) {
          try {
            const ytApiRes = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "X-YouTube-Client-Name": profile.client.clientName === "IOS" ? "5" : (profile.client.clientName === "ANDROID" ? "3" : "85"),
                "X-YouTube-Client-Version": profile.client.clientVersion
              },
              body: JSON.stringify({
                context: { client: profile.client, ...(profile.thirdParty ? { thirdParty: profile.thirdParty } : {}) },
                videoId: videoId,
                contentCheckOk: true,
                racyCheckOk: true
              }),
              signal: AbortSignal.timeout(4000)
            });

            if (!ytApiRes.ok) continue;

            const ytData = await ytApiRes.json();
            const formats = ytData?.streamingData?.formats || [];
            const adaptive = ytData?.streamingData?.adaptiveFormats || [];
            const all = [...formats, ...adaptive];

            const directMp4 = all.find(f => f.url && f.mimeType?.includes("video/mp4"));
            if (directMp4 && directMp4.url) {
              resolvedDirectMediaUrl = directMp4.url;
              break;
            }
          } catch (e) {
            continue;
          }
        }

        // Matrix Step 2: Edge Invidious / Piped Multi-Instance Resilient Fallback
        if (!resolvedDirectMediaUrl) {
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
                headers: { "User-Agent": "Mozilla/5.0" },
                signal: AbortSignal.timeout(3000)
              });
              if (!mRes.ok) continue;
              const mData = await mRes.json();
              const streamList = mData.videoStreams || mData.formatStreams || [];
              const matched = streamList.find(s => !s.videoOnly && (s.mimeType?.includes("mp4") || s.container === "mp4")) || streamList[0];
              if (matched && (matched.url || matched.videoUrl)) {
                resolvedDirectMediaUrl = matched.url || matched.videoUrl;
                break;
              }
            } catch (e) {
              continue;
            }
          }
        }
      }

      if (!resolvedDirectMediaUrl) {
        return new Response(JSON.stringify({ success: false, error: "Stream unavailable from upstream media sources." }), {
          headers: jsonHeaders,
          status: 404
        });
      }

      // Pipe Stream to Client with Range Header Relay
      const range = request.headers.get("Range");
      const forwardHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Referer": "https://www.youtube.com/",
        ...(range ? { "Range": range } : {})
      };

      const mediaRes = await fetch(resolvedDirectMediaUrl, { headers: forwardHeaders });

      if (mediaRes.ok || mediaRes.status === 206) {
        const respHeaders = new Headers();
        ["content-type", "content-length", "content-range", "accept-ranges"].forEach(h => {
          const val = mediaRes.headers.get(h);
          if (val) respHeaders.set(h, val);
        });

        respHeaders.set("Content-Type", mediaRes.headers.get("content-type") || "video/mp4");
        respHeaders.set("Accept-Ranges", "bytes");
        respHeaders.set("Access-Control-Allow-Origin", "*");
        respHeaders.set("Access-Control-Allow-Headers", "Range");

        return new Response(mediaRes.body, {
          status: mediaRes.status,
          headers: respHeaders
        });
      }

      return new Response(JSON.stringify({ success: false, error: `Upstream returned status ${mediaRes.status}` }), {
        headers: jsonHeaders,
        status: 502
      });
    }

    // =========================================================================
    // 3. SEARCH & AGGREGATION ENGINE (YOUTUBE + OTHER PLATFORMS)
    // =========================================================================
    if (query) {
      // -----------------------------------------------------------------------
      // MODE A: PRIMARY YOUTUBE ENGINE
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
          return new Response(JSON.stringify({ success: false, error: "YouTube search gateway error" }), { headers: jsonHeaders });
        }

        const html = await searchRes.text();
        const match = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData = ({.*?});/s);

        if (!match || !match[1]) {
          return new Response(JSON.stringify({ success: false, error: "Unable to parse YouTube metadata" }), { headers: jsonHeaders });
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
                    uploader: vr.ownerText?.runs?.[0]?.text || "YouTube Creator",
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
        }), { headers: jsonHeaders });
      }

      // -----------------------------------------------------------------------
      // MODE B: "OTHER" ENGINE (Dailymotion, Vimeo, Internet Archive, PeerTube)
      // -----------------------------------------------------------------------
      if (source === "other") {
        let aggregatedOtherResults = [];

        // 1. Dailymotion API
        try {
          const dmRes = await fetch(`https://api.dailymotion.com/videos?search=${encodeURIComponent(query)}&limit=6&fields=id,title,owner.screenname,duration,thumbnail_240_url`, {
            signal: AbortSignal.timeout(3500)
          });
          if (dmRes.ok) {
            const dmData = await dmRes.json();
            (dmData.list || []).forEach(v => {
              const mins = Math.floor(v.duration / 60);
              const secs = v.duration % 60;
              aggregatedOtherResults.push({
                id: `b64_${btoa(`https://www.dailymotion.com/embed/video/${v.id}`)}`,
                title: v.title || "Dailymotion Video",
                uploader: v["owner.screenname"] || "Dailymotion",
                duration: `${mins}:${secs < 10 ? '0' : ''}${secs}`,
                thumbnail: `/api/video?thumb=${encodeURIComponent(v.thumbnail_240_url || "")}`,
                source: "Dailymotion"
              });
            });
          }
        } catch (e) {}

        // 2. Internet Archive Open Video Library (Direct MP4 Streams)
        try {
          const iaRes = await fetch(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}+AND+mediatype:movies&fl[]=identifier,title,creator,length&sort[]=&rows=6&page=1&output=json`, {
            signal: AbortSignal.timeout(3500)
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

        // 3. PeerTube Open Mesh Engine
        try {
          const ptRes = await fetch(`https://peertube.tv/api/v1/search/videos?search=${encodeURIComponent(query)}&count=6`, {
            signal: AbortSignal.timeout(3500)
          });
          if (ptRes.ok) {
            const ptData = await ptRes.json();
            (ptData.data || []).forEach(v => {
              const mins = Math.floor(v.duration / 60);
              const secs = v.duration % 60;
              const directFile = v.streamingPlaylists?.[0]?.playlistUrl || v.files?.[0]?.fileUrl || v.embedUrl;
              aggregatedOtherResults.push({
                id: `b64_${btoa(directFile)}`,
                title: v.name || "PeerTube Stream",
                uploader: v.account?.displayName || "PeerTube",
                duration: `${mins}:${secs < 10 ? '0' : ''}${secs}`,
                thumbnail: `/api/video?thumb=${encodeURIComponent(`https://peertube.tv${v.thumbnailPath}`)}`,
                source: "PeerTube"
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
        }), { headers: jsonHeaders });
      }
    }

    return new Response(JSON.stringify({ success: false, error: "Missing required parameter" }), {
      headers: jsonHeaders,
      status: 400
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: "Edge worker exception: " + err.message }), {
      headers: jsonHeaders,
      status: 500
    });
  }
}
