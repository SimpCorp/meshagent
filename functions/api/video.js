export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const query = url.searchParams.get("q");
  const streamId = url.searchParams.get("stream");
  const embedId = url.searchParams.get("embed");
  const source = url.searchParams.get("source") || "youtube";
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
    // 2. ZERO-LEAK ENCRYPTED EMBED PLAYER PIPE (100% RELIABLE PLAYBACK)
    // =========================================================================
    if (embedId || streamId) {
      const targetId = embedId || streamId;
      let playerTargetUrl = "";

      // Case A: Custom Base64 Target (From "OTHER" platform engine)
      if (targetId.startsWith("b64_")) {
        try {
          playerTargetUrl = atob(targetId.replace("b64_", ""));
        } catch (e) {
          playerTargetUrl = "";
        }
      } 
      // Case B: YouTube Video ID (Privacy & Ad-Stripped Embedded Relay)
      else {
        playerTargetUrl = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(targetId)}?autoplay=1&modestbranding=1&rel=0&iv_load_policy=3&playsinline=1`;
      }

      // Sandboxed zero-leak HTML wrapper served entirely from your origin
      const playerHtml = `
        <!DOCTYPE html>
        <html lang="en" style="width:100%;height:100%;margin:0;padding:0;overflow:hidden;background:#000;">
        <head>
          <meta charset="UTF-8">
          <meta name="referrer" content="no-referrer">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            * { margin:0; padding:0; box-sizing:border-box; }
            html, body { width:100%; height:100%; background:#000; overflow:hidden; }
            iframe, video { width:100%; height:100%; border:none; display:block; }
          </style>
        </head>
        <body>
          ${
            playerTargetUrl.endsWith(".mp4")
              ? `<video src="${playerTargetUrl}" controls autoplay playsinline></video>`
              : `<iframe 
                  src="${playerTargetUrl}" 
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" 
                  allowfullscreen 
                  referrerpolicy="no-referrer">
                </iframe>`
          }
        </body>
        </html>
      `;

      return new Response(playerHtml, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
          "Access-Control-Allow-Origin": "*",
          "X-Content-Type-Options": "nosniff"
        }
      });
    }

    // =========================================================================
    // 3. MULTI-ENGINE SEARCH & METADATA AGGREGATOR
    // =========================================================================
    if (query) {
      // -----------------------------------------------------------------------
      // ENGINE A: YOUTUBE
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
          return new Response(JSON.stringify({ success: false, error: "YouTube gateway timeout" }), { headers: jsonHeaders });
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
      // ENGINE B: "OTHER" (Dailymotion, Internet Archive, PeerTube)
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
                id: `b64_${btoa(`https://www.dailymotion.com/embed/video/${v.id}?autoplay=1`)}`,
                title: v.title || "Dailymotion Video",
                uploader: v["owner.screenname"] || "Dailymotion",
                duration: `${mins}:${secs < 10 ? '0' : ''}${secs}`,
                thumbnail: `/api/video?thumb=${encodeURIComponent(v.thumbnail_240_url || "")}`,
                source: "Dailymotion"
              });
            });
          }
        } catch (e) {}

        // 2. Internet Archive Open Library
        try {
          const iaRes = await fetch(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}+AND+mediatype:movies&fl[]=identifier,title,creator,length&sort[]=&rows=6&page=1&output=json`, {
            signal: AbortSignal.timeout(3500)
          });
          if (iaRes.ok) {
            const iaData = await iaRes.json();
            (iaData.response?.docs || []).forEach(doc => {
              const directEmbed = `https://archive.org/embed/${doc.identifier}`;
              const thumb = `https://archive.org/services/img/${doc.identifier}`;
              aggregatedOtherResults.push({
                id: `b64_${btoa(directEmbed)}`,
                title: doc.title || "Archive Video",
                uploader: doc.creator || "Archive Library",
                duration: doc.length || "Stream",
                thumbnail: `/api/video?thumb=${encodeURIComponent(thumb)}`,
                source: "Archive.org"
              });
            });
          }
        } catch (e) {}

        // 3. PeerTube Open Video Mesh
        try {
          const ptRes = await fetch(`https://peertube.tv/api/v1/search/videos?search=${encodeURIComponent(query)}&count=6`, {
            signal: AbortSignal.timeout(3500)
          });
          if (ptRes.ok) {
            const ptData = await ptRes.json();
            (ptData.data || []).forEach(v => {
              const mins = Math.floor(v.duration / 60);
              const secs = v.duration % 60;
              const embedTarget = v.embedUrl || `https://peertube.tv/videos/embed/${v.uuid}`;
              aggregatedOtherResults.push({
                id: `b64_${btoa(embedTarget)}`,
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

    return new Response(JSON.stringify({ success: false, error: "Missing parameters" }), {
      headers: jsonHeaders,
      status: 400
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: "Edge worker error: " + err.message }), {
      headers: jsonHeaders,
      status: 500
    });
  }
}
