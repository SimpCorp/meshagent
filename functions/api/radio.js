export async function onRequest(context) {
  const { searchParams } = new URL(context.request.url);
  const channel = searchParams.get('channel')?.toLowerCase() || 'english';

  const STREAMS = {
    english: "https://streams.ilovemusic.de/iloveradio1.mp3",
    hindi: "https://stream.zeno.fm/f3wvbbqmdg8uv",
    south: "https://stream.zeno.fm/s8s62tqmdg8uv",
    other: "https://stream.zeno.fm/7k9yvbqmdg8uv"
  };

  const targetUrl = STREAMS[channel] || STREAMS.english;

  try {
    const upstreamRes = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "*/*"
      }
    });

    return new Response(upstreamRes.body, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-cache, no-store",
        "Access-Control-Allow-Origin": "*"
      }
    });
  } catch (err) {
    return new Response("Stream offline", { status: 502 });
  }
}
