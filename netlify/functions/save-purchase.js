// Netlify serverless function — centrally records every purchase/QR event
// into Netlify Blobs, so the CRM page can see data from every tourist's
// device, not just what's stored locally on each phone.

const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  try {
    const item = JSON.parse(event.body || "{}");
    if (!item.id) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing item id" }) };
    }
    const store = getStore("purchases");
    await store.setJSON(item.id, item);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
