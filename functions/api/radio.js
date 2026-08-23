/**
 * Cloudflare Pages Functions - /api/radio
 * Reverse-proxies audio streams with 15-second persistent multi-station retries,
 * browser-spoofed headers (bypassing CDN/Datacenter IP blocks), and a seamless Lo-Fi fallback.
 */

const STATIONS = {
  hindi: [
    "https://stream.zeno.fm/f3wvbbqmdg8uv", // Bollywood Hits
    "https://stream.zeno.fm/0r0xa792kwzuv", // Radio Mirchi Mirror
    "https://mirchi-hindi.streamguys1.com/mirchi-hindi",
    "https://stream.zeno.fm/3hww9cydg8uv"  // Desi Retro
  ],
  south: [
    "https://stream.zeno.fm/v22nwtkgwzruv", // Tamil Regional Hits
    "https://stream.zeno.fm/s494y9s7wzruv", // South Gold / Telugu
    "https://stream.zeno.fm/k2y0q0a2kwzuv", // Malayalam / Regional Mirror
    "https://stream.zeno.fm/05w6t72q4ehvv"  // South Mega Live
  ],
  english: [
    "https://icecast.somafm.com/groovesalad-128-mp3",
    "https://stream.nightwaveplaza.com/plaza.mp3",
    "https://stream-relay-geo.ntslive.net/stream",
    "https://icecast.somafm.com/indiepop-128-mp3"
  ],
  other: [
    "https://icecast.somafm.com/chill-128-mp3",
    "https://icecast.somafm.com/dronezone-128-mp3",
    "https://icecast.somafm.com/lush-128-mp3"
  ]
};

// High-Uptime 24/7 Lo-Fi Fallback Relays
const LOFI_FALLBACK_STREAMS = [
  "https://icecast.somafm.com/chill-128-mp3",
  "https://stream.nightwaveplaza.com/plaza.mp3",
  "https://icecast.somafm.com/groovesalad-128-mp3"
];

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Icy-MetaData": "0"
};

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const channel = (url.searchParams.get("channel") || "english").toLowerCase();
  const candidates = STATIONS[channel] || STATIONS.english;

  const OVERALL_DEADLINE_MS = 15000; // 15-second hard budget before switching to Lo-Fi
  const overallStartTime = Date.now();

  // 1. Attempt all primary channel candidates within the 15-second budget
  for (let i = 0; i < candidates.length; i++) {
    const elapsed = Date.now() - overallStartTime;
    if (elapsed >= OVERALL_DEADLINE_MS) break;

    const remainingTime = Math.min(4500, OVERALL_DEADLINE_MS - elapsed);
    const streamUrl = candidates[i];

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), remainingTime);

      const response = await fetch(streamUrl, {
        method: "GET",
        headers: BROWSER_HEADERS,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok && response.body) {
        return new Response(response.body, {
          status: 200,
          headers: {
            "Content-Type": response.headers.get("Content-Type") || "audio/mpeg",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Access-Control-Allow-Origin": "*",
            "X-Radio-Channel": channel,
            "X-Radio-Station": `primary-${i}`
          }
        });
      }
    } catch (err) {
      // Station timed out or dropped; cycle to the next candidate
      continue;
    }
  }

  // 2. If all attempts failed after 15 seconds, connect to the Lo-Fi fallback stream
  for (const lofiUrl of LOFI_FALLBACK_STREAMS) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      const lofiResponse = await fetch(lofiUrl, {
        method: "GET",
        headers: BROWSER_HEADERS,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (lofiResponse.ok && lofiResponse.body) {
        return new Response(lofiResponse.body, {
          status: 200,
          headers: {
            "Content-Type": lofiResponse.headers.get("Content-Type") || "audio/mpeg",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Access-Control-Allow-Origin": "*",
            "X-Radio-Channel": channel,
            "X-Radio-Fallback": "lofi-stream"
          }
        });
      }
    } catch (err) {
      continue;
    }
  }

  return new Response("All radio streams and fallback relays are currently offline.", {
    status: 502,
    headers: {
      "Content-Type": "text/plain",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
