// Shared data and helpers for the fixture pages. Deterministic: no timers, no randomness, no network.
const PRODUCTS = [
  { id: "1", name: "Canvas Tote Bag", price: 24 },
  { id: "2", name: "Ceramic Mug", price: 12 },
  { id: "3", name: "Wool Socks", price: 9 },
];
const VALID_USER = { username: "tester", password: "correct-horse" };
const APPROVED_CARD = "4242424242424242";

function findProduct(id) {
  return PRODUCTS.find((p) => p.id === id);
}
function readCart() {
  return JSON.parse(sessionStorage.getItem("cart") || "[]");
}
function writeCart(items) {
  sessionStorage.setItem("cart", JSON.stringify(items));
}
