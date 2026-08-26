export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const channel = (url.searchParams.get("channel") || "english").toLowerCase().trim();

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Content-Type": "audio/mpeg",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "X-Content-Type-Options": "nosniff"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // =========================================================================
  // 1. HARDENED STATIC STREAM ARRAYS (PRIMARY + FALLBACKS)
  // =========================================================================
  const STREAM_POOLS = {
    hindi: [
      "https://drive.uber.radio/uber/bollywoodmix/icecast.audio",
      "https://drive.uber.radio/uber/bollywood/icecast.audio",
      "https://drive.uber.radio/uber/bollywood2000s/icecast.audio",
      "https://server.mixify.in/listen/new_hits/radio.mp3",
      "https://stream.zeno.fm/f3wvbbqmdg8uv",
      "https://stream.zeno.fm/cub84trbgy5tv"
    ],
    south: [
      "https://stream.zeno.fm/amlydol2msyuv", // Tamil Katerumbu FM
      "https://stream.zeno.fm/r0aab8wanf9uv", // Kandy Tamil Hits
      "https://drive.uber.radio/uber/tamilhits/icecast.audio",
      "https://drive.uber.radio/uber/teluguhits/icecast.audio",
      "https://stream.zeno.fm/60pqgs97f2zuv",
      "https://drive.uber.radio/uber/malayalamhits/icecast.audio"
    ],
    other: [
      "https://stream.zeno.fm/u3uaxaq6wp8uv", // EDM Club Hits
      "https://stream.zeno.fm/hqbrk7skwxhvv", // Lofi Instrumentals 24/7
      "https://stream.zeno.fm/iitnog3filatv", // Viral Hits / Dance
      "https://drive.uber.radio/uber/edm/icecast.audio",
      "https://icecast5.play.cz/rockzone128.mp3"
    ],
    english: [
      "https://stream.zeno.fm/hqbrk7skwxhvv", // Lofi English Beats
      "https://streaming.positivity.radio/pr/goodafternoon/icecast.audio",
      "https://drive.uber.radio/uber/top40/icecast.audio",
      "https://drive.uber.radio/uber/chillout/icecast.audio"
    ]
  };

  const candidateUrls = STREAM_POOLS[channel] || STREAM_POOLS.english;

  // =========================================================================
  // 2. ATTEMPT STATIC STREAM POOLS
  // =========================================================================
  for (const streamUrl of candidateUrls) {
    try {
      const response = await fetch(streamUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "*/*"
        },
        signal: AbortSignal.timeout(3000) // Fast 3-second timeout per candidate
      });

      if (response.ok && response.body) {
        const contentType = response.headers.get("content-type") || "audio/mpeg";
        return new Response(response.body, {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": contentType
          }
        });
      }
    } catch (err) {
      continue; // Move to the next backup stream immediately
    }
  }

  // =========================================================================
  // 3. LIVE AUTO-DISCOVERY FALLBACK (RADIO-BROWSER API)
  // =========================================================================
  const tagMap = {
    hindi: "hindi",
    south: "tamil",
    other: "edm",
    english: "top40"
  };
  const searchTag = tagMap[channel] || "hits";

  try {
    const apiDiscoveryRes = await fetch(
      `https://de1.api.radio-browser.info/json/stations/bytag/${searchTag}?limit=5&order=votes&reverse=true`,
      {
        headers: { "User-Agent": "MeshRelayAudio/2.0" },
        signal: AbortSignal.timeout(3500)
      }
    );

    if (apiDiscoveryRes.ok) {
      const stations = await apiDiscoveryRes.json();
      for (const station of stations) {
        if (station.url_resolved || station.url) {
          try {
            const liveStreamUrl = station.url_resolved || station.url;
            const liveRes = await fetch(liveStreamUrl, {
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "*/*"
              },
              signal: AbortSignal.timeout(3000)
            });

            if (liveRes.ok && liveRes.body) {
              const liveType = liveRes.headers.get("content-type") || "audio/mpeg";
              return new Response(liveRes.body, {
                status: 200,
                headers: {
                  ...corsHeaders,
                  "Content-Type": liveType
                }
              });
            }
          } catch (e) {
            continue;
          }
        }
      }
    }
  } catch (apiErr) {}

  // =========================================================================
  // 4. GUARANTEED FINAL BACKUP STREAM
  // =========================================================================
  const emergencyBackup = "https://stream.zeno.fm/hqbrk7skwxhvv";
  const finalRes = await fetch(emergencyBackup);
  return new Response(finalRes.body, {
    status: 200,
    headers: corsHeaders
  });
}
