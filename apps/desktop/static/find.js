// Plain browser script: the sandboxed find bar has no module system or Node.
const api = window.defe2endFind;
const text = document.getElementById("text");
const count = document.getElementById("count");
let last = "";

const search = (forward, findNext) => {
  api.query(text.value, forward, findNext && text.value === last);
  last = text.value;
};

text.addEventListener("input", () => search(true, false));
text.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    search(!event.shiftKey, true);
  } else if (event.key === "Escape") {
    event.preventDefault();
    api.close();
  }
});
document.getElementById("previous").addEventListener("click", () => search(false, true));
document.getElementById("next").addEventListener("click", () => search(true, true));
document.getElementById("close").addEventListener("click", () => api.close());

api.onLabels((labels) => {
  text.placeholder = labels.placeholder;
  document.getElementById("previous").title = labels.previous;
  document.getElementById("next").title = labels.next;
  document.getElementById("close").title = labels.close;
});
api.onResult((label) => {
  count.textContent = label;
});
api.onFocus(() => {
  text.focus();
  text.select();
});
