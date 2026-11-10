// Fills in the address of the site this guide is served from, so the examples are always current.
document.querySelectorAll("[data-origin]").forEach((el) => { el.textContent = location.origin; });
