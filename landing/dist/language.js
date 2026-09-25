(() => {
  const preferenceKey = "anchi-language";
  const path = window.location.pathname;
  const explicitLanguage = path.match(/^\/(zh|en)(?:\/|$)/)?.[1];

  // Explicit language URLs always win over a saved preference.
  try {
    if (explicitLanguage) {
      localStorage.setItem(preferenceKey, explicitLanguage);
    } else if (path === "/" || path === "/index.html") {
      const savedLanguage = localStorage.getItem(preferenceKey);
      if (savedLanguage === "en" || savedLanguage === "zh") {
        window.location.replace(
          `/${savedLanguage}/${window.location.search}${window.location.hash}`,
        );
      }
    }
  } catch {
    // Both static pages and their links also work without browser storage.
  }

  document.querySelectorAll("[data-language]").forEach((link) => {
    link.href = `/${link.dataset.language}/${window.location.search}${window.location.hash}`;
    link.addEventListener("click", () => {
      try {
        localStorage.setItem(preferenceKey, link.dataset.language);
      } catch {
        // Navigation does not depend on a stored preference.
      }
    });
  });

  window.addEventListener("hashchange", () => {
    document.querySelectorAll("[data-language]").forEach((link) => {
      link.href = `/${link.dataset.language}/${window.location.search}${window.location.hash}`;
    });
  });
})();
