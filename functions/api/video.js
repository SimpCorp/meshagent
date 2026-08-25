function playInlineVideo(btnElement, videoId) {
  const container = document.getElementById(`video-box-${videoId}`);
  if (!container) return;

  btnElement.innerText = "Buffering...";
  btnElement.disabled = true;

  // Stream URL is 100% relative to your own domain (meshage.pages.dev)
  const proxiedStreamUrl = `/api/video?stream=${encodeURIComponent(videoId)}`;

  container.innerHTML = `
    <div class="relative w-full aspect-video rounded-xl overflow-hidden bg-black shadow-md border border-slate-200 dark:border-slate-800 flex items-center justify-center">
      <video 
        controls 
        autoplay 
        playsinline 
        preload="auto"
        class="w-full h-full object-contain"
        onerror="handleVideoPlayError(this, '${videoId}')">
        <source src="${proxiedStreamUrl}" type="video/mp4">
        Your browser does not support HTML5 video playback.
      </video>
    </div>
  `;
}

function handleVideoPlayError(videoElem, videoId) {
  const container = document.getElementById(`video-box-${videoId}`);
  if (!container) return;
  container.innerHTML = `
    <div class="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-left space-y-1">
      <p class="text-[11px] font-bold text-rose-500 flex items-center gap-1">
        <span>⚠️</span> Stream Proxy Error
      </p>
      <p class="text-[10px] text-slate-400 leading-relaxed">
        Cloudflare edge relay was unable to pipe this video stream. Try another result.
      </p>
    </div>
  `;
}
