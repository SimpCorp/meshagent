export async function onRequest(context) {
  const url = new URL(context.request.url);

  // 1-Week Redirect Window: Expires August 30, 2026
  const EXPIRATION_DATE = new Date("2026-08-30T23:59:59Z");
  const now = new Date();

  // If traffic lands on nomesh.pages.dev
  if (url.hostname.includes("nomesh.pages.dev")) {
    if (now < EXPIRATION_DATE) {
      // 302 Temporary Redirect (not permanently cached by browsers)
      url.hostname = "meshage.pages.dev";
      return Response.redirect(url.toString(), 302);
    } else {
      // After 7 days: Shows permanent relocation notice
      return new Response(
        `<!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Service Relocated</title>
          <style>
            body { background: #080A0F; color: #fff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
            a { color: #60A5FA; text-decoration: none; font-weight: bold; }
          </style>
        </head>
        <body>
          <div>
            <h2>nomesh has permanently moved</h2>
            <p>Access the terminal at <a href="https://meshage.pages.dev">meshage.pages.dev</a></p>
          </div>
        </body>
        </html>`,
        {
          status: 410,
          headers: { "Content-Type": "text/html; charset=utf-8" }
        }
      );
    }
  }

  return context.next();
}
