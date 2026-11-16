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
  const confirm = document.querySelector("[data-confirm]");
  const approvalPanel = document.querySelector("#panel-approval");
  let decision = null;
  function choose(value) {
    decision = value;
    decisionButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.decision === value)));
    confirm.hidden = false;
    result.textContent = isChinese
      ? `已选择${value === "approved" ? "批准" : "拒绝"}。按 Enter 确认。`
      : `Selected ${value === "approved" ? "approve" : "deny"}. Press Enter to confirm.`;
  }
  function finish() {
    if (!decision) return;
    const approved = decision === "approved";
    result.textContent = isChinese
      ? approved ? "✓ 模拟已批准。此演示不会执行操作。" : "× 模拟已拒绝。此演示不会执行操作。"
      : approved ? "✓ Example approved. No operation is executed." : "× Example denied. No operation is executed.";
    approvalStatus.textContent = approved ? "✓ approved" : "× denied";
    decisionButtons.forEach((button) => { button.hidden = true; });
    confirm.hidden = true;
    reset.hidden = false;
    reset.focus();
    decision = null;
  }
  decisionButtons.forEach((button) => {
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => choose(button.dataset.decision));
  });
  confirm?.addEventListener("click", finish);
  approvalPanel?.addEventListener("keydown", (event) => {
    if (!reset.hidden || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "y" || event.key === "n") {
      event.preventDefault();
      choose(event.key === "y" ? "approved" : "denied");
    } else if (event.key === "Enter" && decision) {
      event.preventDefault();
      finish();
    }
  });
  reset?.addEventListener("click", () => {
    decision = null;
    result.textContent = "";
    approvalStatus.textContent = "1 pending";
    decisionButtons.forEach((button) => {
      button.hidden = false;
      button.setAttribute("aria-pressed", "false");
    });
    confirm.hidden = true;
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
