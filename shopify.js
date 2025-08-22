import "dotenv/config";
import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const ENDPOINT = `https://${SHOP}/admin/api/2024-07/graphql.json`;

export async function shopifyGraphQL(query, variables) {
  if (!SHOP || !TOKEN) throw new Error("Faltan SHOPIFY_SHOP o SHOPIFY_ADMIN_TOKEN");
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}
