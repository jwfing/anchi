(() => {
  // Hold the hero animation on its poster frame when motion is reduced.
  const heroVideo = document.querySelector(".fleet-video");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  function applyMotionPreference() {
    if (!heroVideo) return;
    if (reducedMotion.matches) {
      heroVideo.pause();
      heroVideo.currentTime = 0;
    } else {
      heroVideo.play().catch(() => {});
    }
  }
  applyMotionPreference();
  reducedMotion.addEventListener("change", applyMotionPreference);
})();
