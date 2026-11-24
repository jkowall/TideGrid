// On a phone there is no room for a frame: open the app itself, full screen.
// The query ?frame keeps the frame, for checking the page at a narrow width.
(() => {
  const narrow = window.matchMedia("(max-width: 640px)").matches;
  if (narrow && !new URLSearchParams(window.location.search).has("frame")) {
    window.location.replace("/app/");
  }
})();
