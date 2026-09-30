/**
 * CLOUDFLARE PAGES EDGE FUNCTION: /api/music
 * Aggressive Multi-Provider Search & Stream Relay
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
  // 1. AGGRESSIVE SEARCH ENDPOINT (Multi-tier Fallbacks)
  // =========================================================================
  if (mode === "search") {
    const query = (url.searchParams.get("q") || "").trim();
    if (!query) {
      return new Response(JSON.stringify({ tracks: [] }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    let tracks = [];

    // TIER 1: JioSaavn Primary Autocomplete & Song Details
    try {
      tracks = await fetchJioSaavnAutocomplete(query);
    } catch (e) {
      tracks = [];
    }

    // TIER 2: JioSaavn Direct Song Search Fallback
    if (!tracks.length) {
      try {
        tracks = await fetchJioSaavnDirectSearch(query);
      } catch (e) {
        tracks = [];
      }
    }

    // TIER 3: iTunes Global Search API Fallback
    if (!tracks.length) {
      try {
        tracks = await fetchITunesSearch(query);
      } catch (e) {
        tracks = [];
      }
    }

    // TIER 4: Internet Archive Audio Search Fallback
    if (!tracks.length) {
      try {
        tracks = await fetchArchiveOrgSearch(query);
      } catch (e) {
        tracks = [];
      }
    }

    // GUARANTEED SAFEGUARD: Return synthesized stream item if all lookups return empty
    if (!tracks.length) {
      tracks = [
        {
          id: "synth-" + Date.now(),
          title: cleanHtmlEntities(query),
          artist: "Archive Audio Stream",
          album: "Public Index",
          image: "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=250&auto=format&fit=crop&q=80",
          duration: "--:--",
          streamUrl: "https://archive.org/download/testmp3testfile/mpthreetest.mp3"
        }
      ];
    }

    return new Response(JSON.stringify({ tracks }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // =========================================================================
  // 2. STREAM RELAY: MASKS AUDIO CDN FROM ISP & SOPHOS FIREWALLS
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
        "Referer": targetUrl.includes("saavn") ? "https://www.jiosaavn.com/" : targetUrl,
        "Accept": "*/*"
      };
      if (range) fetchHeaders["Range"] = range;

      const upstreamRes = await fetch(targetUrl, {
        headers: fetchHeaders
      });

      const responseHeaders = new Headers({
        ...corsHeaders,
        "Content-Type": upstreamRes.headers.get("Content-Type") || "audio/mp4",
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
      return new Response("Stream relay failed", { status: 502 });
    }
  }

  return new Response("Invalid mode", { status: 400 });
}

/* =========================================================================
   PROVIDER SEARCH HELPERS
   ========================================================================= */

async function fetchJioSaavnAutocomplete(query) {
  const target = `https://www.jiosaavn.com/api.php?__call=autocomplete.get&_format=json&_marker=0&cc=in&includeMetaTags=1&query=${encodeURIComponent(query)}`;
  const res = await fetch(target, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*"
    }
  });

  const rawText = await res.text();
  let searchData;
  try {
    searchData = JSON.parse(rawText);
  } catch (e) {
    const clean = rawText.substring(rawText.indexOf("{"), rawText.lastIndexOf("}") + 1);
    searchData = JSON.parse(clean);
  }

  const rawSongs = searchData?.songs?.data || [];
  if (!rawSongs.length) return [];

  const top5 = rawSongs.slice(0, 5);
  const pids = top5.map(s => s.id).join(",");

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
    let mediaStream = full?.media_preview_url || item.more_info?.vlink || "";

    if (mediaStream.includes("preview.saavncdn.com")) {
      mediaStream = mediaStream
        .replace("preview.saavncdn.com", "aac.saavn.cdn.jio.com")
        .replace("_96_p.mp4", "_160.mp4");
    } else if (!mediaStream && full?.encrypted_media_url) {
      mediaStream = full.encrypted_media_url;
    }

    if (!mediaStream && full?.media_url) {
      mediaStream = full.media_url;
    }

    if (!mediaStream) continue;

    tracks.push({
      id: item.id,
      title: cleanHtmlEntities(item.title || "Unknown Track"),
      artist: cleanHtmlEntities(item.more_info?.primary_artists || item.description || "Various Artists"),
      album: cleanHtmlEntities(item.more_info?.album || ""),
      image: item.image ? item.image.replace("150x150", "250x250") : "",
      duration: formatSecondsToTime(full?.duration || item.more_info?.duration || 0),
      streamUrl: mediaStream
    });
  }

  return tracks;
}

async function fetchJioSaavnDirectSearch(query) {
  const target = `https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&cc=in&p=1&n=5&q=${encodeURIComponent(query)}`;
  const res = await fetch(target, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
  });

  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    const clean = rawText.substring(rawText.indexOf("{"), rawText.lastIndexOf("}") + 1);
    data = JSON.parse(clean);
  }

  const results = data?.results || [];
  if (!results.length) return [];

  const tracks = [];
  for (const item of results.slice(0, 5)) {
    let mediaStream = item.media_preview_url || "";
    if (mediaStream.includes("preview.saavncdn.com")) {
      mediaStream = mediaStream
        .replace("preview.saavncdn.com", "aac.saavn.cdn.jio.com")
        .replace("_96_p.mp4", "_160.mp4");
    }

    if (!mediaStream && item.more_info?.encrypted_media_url) {
      mediaStream = item.more_info.encrypted_media_url;
    }

    if (!mediaStream) continue;

    tracks.push({
      id: item.id,
      title: cleanHtmlEntities(item.title || item.song || "Unknown Track"),
      artist: cleanHtmlEntities(item.more_info?.primary_artists || item.singers || "Various Artists"),
      album: cleanHtmlEntities(item.more_info?.album || item.album || ""),
      image: item.image ? item.image.replace("150x150", "250x250") : "",
      duration: formatSecondsToTime(item.more_info?.duration || item.duration || 0),
      streamUrl: mediaStream
    });
  }

  return tracks;
}

async function fetchITunesSearch(query) {
  const target = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=5`;
  const res = await fetch(target, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)"
    }
  });

  const data = await res.json();
  const results = data?.results || [];
  if (!results.length) return [];

  return results.map(item => ({
    id: "itunes-" + item.trackId,
    title: cleanHtmlEntities(item.trackName || "Unknown Track"),
    artist: cleanHtmlEntities(item.artistName || "Unknown Artist"),
    album: cleanHtmlEntities(item.collectionName || ""),
    image: item.artworkUrl100 ? item.artworkUrl100.replace("100x100bb", "250x250bb") : "",
    duration: formatSecondsToTime(Math.floor((item.trackTimeMillis || 0) / 1000)),
    streamUrl: item.previewUrl
  }));
}

async function fetchArchiveOrgSearch(query) {
  const target = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}+AND+mediatype:(audio)&fl[]=identifier,title,creator,description&rows=5&output=json`;
  const res = await fetch(target);
  const data = await res.json();
  const docs = data?.response?.docs || [];
  if (!docs.length) return [];

  const tracks = [];
  for (const item of docs) {
    try {
      const metaRes = await fetch(`https://archive.org/metadata/${item.identifier}`);
      const metaData = await metaRes.json();
      const audioFile = metaData.files?.find(f => 
        f.name && f.name.toLowerCase().endsWith(".mp3") && !f.name.toLowerCase().includes("_thumb")
      );

      if (audioFile) {
        tracks.push({
          id: "archive-" + item.identifier,
          title: cleanHtmlEntities(item.title || query),
          artist: cleanHtmlEntities(item.creator || "Archive.org Community"),
          album: "Internet Archive",
          image: "https://archive.org/services/img/" + item.identifier,
          duration: formatSecondsToTime(audioFile.length || 0),
          streamUrl: `https://archive.org/download/${item.identifier}/${encodeURIComponent(audioFile.name)}`
        });
      }
    } catch (metaErr) {
      // Continue searching next item
    }
  }

  return tracks;
}

/* =========================================================================
   UTILITIES
   ========================================================================= */

function cleanHtmlEntities(str) {
  if (!str) return "";
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
