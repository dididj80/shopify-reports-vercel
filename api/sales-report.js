// api/sales-report.js
import { DateTime } from "luxon";
import { Resend } from "resend";

// Variabili ambiente da Vercel
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const RESEND_KEY = process.env.RESEND_KEY;
const REPORT_EMAIL_TO = process.env.REPORT_EMAIL_TO;
const REPORT_EMAIL_FROM = process.env.REPORT_EMAIL_FROM || "reports@" + SHOPIFY_SHOP;

const resend = new Resend(RESEND_KEY);

// -----------------------------------
// Helpers Shopify API
// -----------------------------------

async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(`https://${SHOPIFY_SHOP}/admin/api/2025-07/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors || data.data?.errors) {
    throw new Error("Shopify GraphQL errors: " + JSON.stringify(data.errors || data.data?.errors));
  }
  return data.data;
}

async function shopifyREST(path) {
  const res = await fetch(`https://${SHOPIFY_SHOP}/admin/api/2025-07/${path}`, {
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
    },
  });
  if (!res.ok) throw new Error(`Shopify REST error ${res.status}`);
  return res.json();
}

// -----------------------------------
// Fetch vendite + inventario
// -----------------------------------

async function fetchOrders(startISO, endISO) {
  const query = `
    query Orders($query: String) {
      orders(first: 100, query: $query) {
        edges {
          node {
            name
            createdAt
            totalPriceSet { shopMoney { amount currencyCode } }
            lineItems(first: 50) {
              edges {
                node {
                  name
                  quantity
                  discountedTotalSet { shopMoney { amount currencyCode } }
                  variant { id sku inventoryItem { id } }
                }
              }
            }
            transactions {
              gateway
            }
            sourceName
          }
        }
      }
    }`;

  const filter = `created_at:>=${startISO} created_at:<=${endISO}`;
  const data = await shopifyGraphQL(query, { query: filter });
  return data.orders.edges.map(e => e.node);
}

async function fetchInventoryLevels(inventoryItemIds) {
  if (!inventoryItemIds.length) return {};
  const chunks = [];
  for (let i = 0; i < inventoryItemIds.length; i += 50) {
    chunks.push(inventoryItemIds.slice(i, i + 50));
  }
  const results = {};
  for (const chunk of chunks) {
    const ids = chunk.map(id => `"${id}"`).join(",");
    const query = `
      query {
        nodes(ids:[${ids}]) {
          ... on InventoryItem {
            id
            inventoryLevels(first:1) {
              edges { node { available } }
            }
          }
        }
      }`;
    const data = await shopifyGraphQL(query);
    data.nodes.forEach(n => {
      if (n && n.inventoryLevels.edges.length) {
        results[n.id] = n.inventoryLevels.edges[0].node.available;
      }
    });
  }
  return results;
}

// Purchase Orders REST → incoming
async function fetchIncomingFromPO() {
  const poData = await shopifyREST("purchase_orders.json?status=open");
  const incoming = {};
  if (poData && poData.purchase_orders) {
    for (const po of poData.purchase_orders) {
      if (po.line_items) {
        for (const li of po.line_items) {
          const invId = li.inventory_item_id?.toString();
          if (invId) {
            incoming[invId] = (incoming[invId] || 0) + (li.quantity - li.received_quantity);
          }
        }
      }
    }
  }
  return incoming;
}

// -----------------------------------
// Report HTML
// -----------------------------------

function renderTable(title, rows, headers) {
  return `
  <h3>${title}</h3>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px;">
    <thead><tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr></thead>
    <tbody>
      ${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}
    </tbody>
  </table>`;
}

function renderChart(title, labels, values, colors) {
  const total = values.reduce((a, b) => a + b, 0);
  const slices = values.map((v, i) => {
    const angle = (v / total) * Math.PI * 2;
    return { angle, color: colors[i], label: labels[i] };
  });
  let acc = 0;
  const paths = slices.map(s => {
    const x1 = 100 + 100 * Math.cos(acc);
    const y1 = 100 + 100 * Math.sin(acc);
    acc += s.angle;
    const x2 = 100 + 100 * Math.cos(acc);
    const y2 = 100 + 100 * Math.sin(acc);
    const largeArc = s.angle > Math.PI ? 1 : 0;
    return `<path d="M100,100 L${x1},${y1} A100,100 0 ${largeArc} 1 ${x2},${y2} Z" fill="${s.color}"><title>${s.label}: ${Math.round((s.angle/(2*Math.PI))*100)}%</title></path>`;
  });
  const legend = labels.map((l,i)=>`<div><span style="display:inline-block;width:12px;height:12px;background:${colors[i]};margin-right:4px;"></span>${l}: ${values[i]}</div>`).join("");
  return `
  <h3>${title}</h3>
  <svg width="220" height="220" viewBox="0 0 220 220">${paths.join("")}</svg>
  <div>${legend}</div>`;
}

// -----------------------------------
// Handler principale
// -----------------------------------

export default async function handler(req, res) {
  try {
    const { period = "daily", preview, today, current } = req.query;

    const tz = "America/Monterrey";
    let start, end;
    const now = DateTime.now().setZone(tz);

    if (period === "daily") {
      if (today) {
        start = now.startOf("day");
        end = now.endOf("day");
      } else {
        start = now.minus({ days: 1 }).startOf("day");
        end = now.minus({ days: 1 }).endOf("day");
      }
    } else if (period === "weekly") {
      if (current) {
        start = now.startOf("week");
        end = now.endOf("day");
      } else {
        start = now.minus({ weeks: 1 }).startOf("week");
        end = now.minus({ weeks: 1 }).endOf("week");
      }
    } else if (period === "monthly") {
      if (current) {
        start = now.startOf("month");
        end = now.endOf("day");
      } else {
        start = now.minus({ months: 1 }).startOf("month");
        end = now.minus({ months: 1 }).endOf("month");
      }
    }

    const orders = await fetchOrders(start.toISO(), end.toISO());

    const itemsMap = {};
    const paymentsCount = {};
    const channelCount = {};

    for (const o of orders) {
      const gatewaySet = new Set();
      for (const t of o.transactions || []) {
        if (t.gateway) gatewaySet.add(t.gateway);
      }
      const payLabel = gatewaySet.size > 1 ? "Pago Mixto" : [...gatewaySet][0] || "Desconocido";
      paymentsCount[payLabel] = (paymentsCount[payLabel] || 0) + 1;

      const ch = o.sourceName === "pos" ? "POS" : "Online";
      channelCount[ch] = (channelCount[ch] || 0) + 1;

      for (const li of o.lineItems.edges) {
        const n = li.node;
        if (!n.variant?.inventoryItem?.id) continue;
        const invId = n.variant.inventoryItem.id;
        const sku = n.variant.sku || "";
        if (!itemsMap[invId]) {
          itemsMap[invId] = {
            product: n.name,
            sku,
            variant: "Default Title",
            sold: 0,
            revenue: 0,
            inventoryItemId: invId,
          };
        }
        itemsMap[invId].sold += n.quantity;
        itemsMap[invId].revenue += parseFloat(n.discountedTotalSet.shopMoney.amount);
      }
    }

    const invLevels = await fetchInventoryLevels(Object.keys(itemsMap));
    const incomingPO = await fetchIncomingFromPO();

    const rows = Object.values(itemsMap).map(it => {
      const invId = it.inventoryItemId.replace("gid://shopify/InventoryItem/","");
      return [
        it.product,
        it.variant,
        it.sku,
        `$${it.revenue/it.sold || 0}`,
        it.sold,
        `$${it.revenue.toFixed(2)}`,
        invLevels[it.inventoryItemId] ?? 0,
        incomingPO[invId] ?? 0
      ];
    });

    // Tabelle
    let html = `<h2>Reporte ${period} — ${start.toFormat("dd LLL yyyy")} – ${end.toFormat("dd LLL yyyy")}</h2>`;
    html += renderTable("Ventas por producto", rows, ["Producto","Variante","SKU","Precio unitario","Vendidas","Ingresos","Inventario","En camino"]);

    // Grafici spostati in fondo
    const channelLabels = Object.keys(channelCount);
    const channelVals = Object.values(channelCount);
    const channelColors = ["#4CAF50","#2196F3","#FFC107","#E91E63"];
    html += renderChart("Canales de venta", channelLabels, channelVals, channelColors);

    const payLabels = Object.keys(paymentsCount);
    const payVals = Object.values(paymentsCount);
    const payColors = ["#9C27B0","#03A9F4","#FF9800","#8BC34A","#F44336"];
    html += renderChart("Métodos de pago", payLabels, payVals, payColors);

    if (preview) {
      res.setHeader("Content-Type","text/html");
      return res.send(html);
    }

    await resend.emails.send({
      from: REPORT_EMAIL_FROM,
      to: REPORT_EMAIL_TO,
      subject: `Reporte ${period} Shopify`,
      html,
    });

    res.json({ ok:true, items: rows.length });

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false, error: err.message });
  }
}
