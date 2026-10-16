// Plain browser script: the sandboxed page has no module system or Node.
const el = document.getElementById("version");
if (el) el.textContent = `v${window.defe2end.version}`;

const form = document.getElementById("setup");
const params = new URLSearchParams(location.search);
// Opened from "Change server address": show where we are and a way back (nothing changes until saved).
if (params.get("change") === "1") {
  const cancel = document.getElementById("cancel");
  cancel.hidden = false;
  cancel.addEventListener("click", () => window.defe2end.setup.cancel());
  document.getElementById("server").value = params.get("current") ?? "";
}
const input = document.getElementById("server");
const message = document.getElementById("message");
const REASONS = {
  invalid: "Use an https:// address (http only for localhost).",
  unreachable: "Couldn't reach that server.",
  not_defe2end: "That address doesn't answer like a defE2End server.",
};

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "Checking…";
  const check = await window.defe2end.setup.check(input.value);
  if (!check?.ok) {
    message.textContent = REASONS[check?.reason] ?? "Couldn't use that address.";
    return;
  }
  message.textContent = `Connecting to ${check.origin}…`;
  const saved = await window.defe2end.setup.save(check.origin);
  if (!saved?.ok) message.textContent = "Couldn't save that address.";
});
