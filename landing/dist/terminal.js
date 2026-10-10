(() => {
  const tabs = [...document.querySelectorAll("[data-view]")];
  const panels = [...document.querySelectorAll(".demo-panel")];
  const tablist = document.querySelector(".view-tabs");
  const isChinese = document.documentElement.lang.startsWith("zh");

  function selectView(tab) {
    tabs.forEach((item) => {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
    });
    panels.forEach((panel) => {
      panel.hidden = panel.id !== tab.getAttribute("aria-controls");
    });
    document.querySelectorAll("[data-side]").forEach((item) => {
      item.classList.toggle(
        "side-selected",
        item.dataset.side === tab.dataset.view,
      );
    });
  }

  if (tablist && tabs.length) {
    tablist.hidden = false;
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => selectView(tab));
      tab.addEventListener("keydown", (event) => {
        let target;
        if (event.key === "ArrowRight") target = (index + 1) % tabs.length;
        if (event.key === "ArrowLeft")
          target = (index - 1 + tabs.length) % tabs.length;
        if (event.key === "Home") target = 0;
        if (event.key === "End") target = tabs.length - 1;
        if (target === undefined) return;
        event.preventDefault();
        selectView(tabs[target]);
        tabs[target].focus();
      });
    });
  }

  const decisionButtons = [...document.querySelectorAll("[data-decision]")];
  const reset = document.querySelector("[data-reset]");
  const result = document.querySelector(".decision-result");
  const approvalStatus = document.querySelector(
    "#panel-approval .panel-heading > span:last-child",
  );
  decisionButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const approved = button.dataset.decision === "approved";
      result.textContent = isChinese
        ? approved
          ? "✓ 模拟已批准。实际操作会在确认后继续。"
          : "× 模拟已拒绝。实际操作会被阻止。"
        : approved
          ? "✓ Example approved. A real operation would now continue."
          : "× Example denied. A real operation would be blocked.";
      approvalStatus.textContent = approved ? "✓ approved" : "× denied";
      decisionButtons.forEach((item) => {
        item.hidden = true;
      });
      reset.hidden = false;
      reset.focus();
    });
  });
  reset?.addEventListener("click", () => {
    result.textContent = "";
    approvalStatus.textContent = "1 pending";
    decisionButtons.forEach((item) => {
      item.hidden = false;
    });
    reset.hidden = true;
    decisionButtons[0].focus();
  });

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
