(() => {
  const button = document.querySelector(".install-copy");
  const command = document.querySelector("#install-command");
  if (!button || !command) return;
  const chinese = document.documentElement.lang.startsWith("zh");
  const label = button.textContent;
  let reset;
  button.hidden = false;
  button.addEventListener("click", async () => {
    clearTimeout(reset);
    try {
      await navigator.clipboard.writeText(command.textContent.trim());
      button.textContent = chinese ? "已复制" : "Copied";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(command);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = chinese ? "手动复制" : "Select + copy";
    }
    reset = setTimeout(() => { button.textContent = label; }, 2500);
  });
})();
