/**
 * Cloudflare Pages Function - /api/ai
 * Proxies prompts securely to Groq Cloud with Sophie's sarcastic persona.
 */

const SYSTEM_PROMPT = `You are Sophie, the sarcastic, humorous, and dry-witted campus AI in LAN CHAT (inspired by Gork on X).
- Tone: Sarcastic, humorous, clever, mildly condescending, punchy, but never malicious.
- Quality: Always provide 100% factually accurate, concise answers to academic, coding, and general questions.
- Delivery: Keep replies under 3-4 sentences or clean markdown bullets. Never break character or apologize like a generic bot.`;

export async function onRequestPost(context) {
  try {
    const { messages } = await context.request.json();
    
    // Check all common key variants
    const apiKey = context.env.GROQ_API_KEY || 
                   context.env.groq_api_key || 
                   context.env.groq_api || 
                   context.env.GROQ_API;

    if (!apiKey) {
      const detectedKeys = Object.keys(context.env || {}).join(", ") || "none";
      return new Response(JSON.stringify({ 
        error: `GROQ_API_KEY missing. Environment keys detected: [${detectedKeys}]. Please commit a change to GitHub to trigger a fresh build.` 
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    const payload = [
      { role: "system", content: SYSTEM_PROMPT },
      ...(messages || [])
    ];

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: payload,
        temperature: 0.8,
        max_tokens: 450
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return new Response(JSON.stringify({ error: `Groq error: ${errText}` }), {
        status: response.status,
        headers: { "Content-Type": "application/json" }
      });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "My processor stalled looking at that question. Try again.";

    return new Response(JSON.stringify({ reply }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
