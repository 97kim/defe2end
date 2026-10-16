// Plain browser script: the sandboxed HUD has no module system or Node.
const ko = new URLSearchParams(location.search).get("locale") === "ko";
const count = document.getElementById("count");
const last = document.getElementById("last");
const render = (n, name) => {
  count.textContent = ko ? `녹화 중 · 스텝 ${n}개` : `Recording · ${n} step${n === 1 ? "" : "s"}`;
  last.textContent = name ?? "";
};
render(0, null);
window.defe2endHud.onUpdate((update) => render(update.count, update.lastName));
