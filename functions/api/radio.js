export async function onRequest(context) {
  const { searchParams } = new URL(context.request.url);
  const channel = searchParams.get('channel')?.toLowerCase() || 'english';

  // Multi-source fallback pools for every category
  const STREAM_POOLS = {
    english: [
      "https://streams.ilovemusic.de/iloveradio1.mp3",
      "https://stream.live.vc.bbcmedia.co.uk/bbc_radio_one",
      "https://dancewave.online/dance.mp3"
    ],
    hindi: [
      "https://sc-bb.1.fm:8017/",                          // 1.FM Bombay Beats India (High Uptime)
      "https://stream.zeno.fm/f3wvbbqmdg8uv",               // Secondary Mirror
      "https://radioindia.net/radio/mirchi98/icecast.audio",// Radio Mirchi Mirror
      "https://stream.zeno.fm/0r0xa792kwzuv"                // Retro Bollywood Relay
    ],
    south: [
      "https://prclive1.listenon.in:9960/",                 // Radio City South Live Direct
      "https://stream.zeno.fm/s8s62tqmdg8uv",               // South Indian Regional
      "https://stream.zeno.fm/4w982392kwzuv",               // Tamil/Telugu Hits
      "https://ice31.securenetsystems.net/CARNATIC"         // Carnatic/Classical FM
    ],
    other: [
      "https://stream.zeno.fm/7k9yvbqmdg8uv",
      "https://streams.ilovemusic.de/iloveradio2.mp3",
      "https://stream.zeno.fm/8wvbbqmdg8uv"
    ]
  };

  const candidateUrls = STREAM_POOLS[channel] || STREAM_POOLS.english;

  // Try each stream candidate sequentially until a healthy stream responds
  for (let i = 0; i < candidateUrls.length; i++) {
    const targetUrl = candidateUrls[i];
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000); // 6s connection deadline per candidate

      const upstreamRes = await fetch(targetUrl, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "*/*",
          "Icy-MetaData": "1"
        }
      });

      clearTimeout(timeoutId);

      // Verify valid response status and active body stream
      if (upstreamRes.ok && upstreamRes.body) {
        return new Response(upstreamRes.body, {
          status: 200,
          headers: {
            "Content-Type": upstreamRes.headers.get("Content-Type") || "audio/mpeg",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Access-Control-Allow-Origin": "*",
            "X-Stream-Source-Index": i.toString()
          }
        });
      }
    } catch (err) {
      // Current candidate timed out or failed; automatically proceeds to candidate i + 1
      continue;
    }
  }

  // If all candidate streams in the pool failed
  return new Response("All regional stream candidates are currently offline.", {
    status: 504,
    headers: {
      "Content-Type": "text/plain",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
