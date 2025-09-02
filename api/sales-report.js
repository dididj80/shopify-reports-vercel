// api/sales-report.js
import fetch from "node-fetch";
import { DateTime } from "luxon";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_TOKEN;
const EMAIL_TO = process.env.REPORT_EMAIL_TO;

// ============ HELPERS =============

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function moneyFormat(amount) {
  return `$${amount.toLocaleString("es-MX", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// ============ FETCH DATA =============

// ordini
async function fetchOrders(period, todayFlag) {
  const now = DateTime.now().setZone("America/Monterrey");
  let from, to;

  if (period === "daily") {
    if (todayFlag) {
      from = now.startOf("day");
      to = now.endOf("day");
    } else {
      from = now.minus({ days: 1 }).startOf("day");
      to = now.minus({ days: 1 }).endOf("day");
    }
  } else if (period === "weekly") {
    from = now.startOf("week");
    to = now.endOf("week");
  } else if (period === "monthly") {
    from = now.startOf("month");
    to = now.endOf("month");
  }

  const url = `https://${SHOP}/admin/api/2024-07/orders.json?status=any&created_at_min=${from.toISO()}&created_at_max=${to.toISO()}`;
  const res = await fetch(url, {
    headers: { "X-Shopify-Access-Token": TOKEN },
  });
  if (!res.ok) throw new Error(`Orders fetch failed ${res.status}`);
  const data = await res.json();
  return data.orders || [];
}

// inventario
async function fetchInventoryLevels() {
  const url = `https://${SHOP}/admin/api/2024-07/inventory_levels.json`;
  const res = await fetch(url, {
    headers: { "X-Shopify-Access-Token": TOKEN },
  });
  if (!res.ok) throw new Error(`Inventory fetch failed ${res.status}`);
  const data = await res.json();
  return data.inventory_levels || [];
}

// purchase orders (solo debug, per incoming → ancora limitato)
async function fetchPurchaseOrders() {
  const url = `https://${SHOP}/admin/api/unstable/purchase_orders.json`;
  const res = await fetch(url, {
    headers: { "X-Shopify-Access-Token": TOKEN },
  });
  if (!res.ok) throw new Error(`PO fetch failed ${res.status}`);
  const data = await res.json();
  return data.purchase_orders || [];
}

// ============ RENDER =============

function renderProductsTable(rows, money) {
  const head = `
  <thead><tr>
    <th align="left">Producto</th>
    <th align="left">Variante</th>
    <th align="left">SKU</th>
    <th align="right">Precio unitario</th>
    <th align="right">Vendidas</th>
    <th align="right">Ingresos</th>
    <th align="right">Inventario</th>
    <th align="right">En camino</th>
  </tr></thead>`;

  const body = rows
    .map((r) => {
      const inv = Number(r.inventoryAvailable ?? 0);
      let rowCls = "";
      let invCell = inv;

      if (inv === 0) {
        rowCls = ' class="row-zero"';
        invCell = '<span class="pill-zero">0</span>';
      } else if (inv === 1) {
        rowCls = ' class="row-one"';
        invCell = '<span class="pill-one">1</span>';
      }

      return `
      <tr${rowCls}>
        <td>${escapeHtml(r.productTitle)}</td>
        <td>${escapeHtml(r.variantTitle)}</td>
        <td>${escapeHtml(r.sku || "")}</td>
        <td align="right">${
          r.unitPrice != null ? money(r.unitPrice) : ""
        }</td>
        <td align="right">${r.soldQty}</td>
        <td align="right">${money(r.revenue)}</td>
        <td align="right">${invCell}</td>
        <td align="right">${r.inventoryIncoming ?? ""}</td>
      </tr>`;
    })
    .join("");

  return `<h3>Ventas por producto</h3><table>${head}<tbody>${body}</tbody></table>`;
}

function baseStyles() {
  return `
  <style>
    body{font-family:Inter,Arial,sans-serif;color:#111}
    table{border-collapse:collapse;width:100%}
    th,td{border:1px solid #e5e7eb;padding:8px;font-size:13px;vertical-align:top}
    th{background:#f3f4f6}
    h2{margin-bottom:6px}
    .muted{color:#6B7280;font-size:12px}
    .spacer{height:16px}

    .row-zero { background:#FEF2F2; }
    .row-zero td { border-color:#FECACA; }
    .pill-zero {
      display:inline-block; padding:2px 8px; border-radius:999px;
      background:#DC2626; color:#fff; font-weight:600; font-size:11px;
    }

    .row-one { background:#FFF7ED; }
    .row-one td { border-color:#FED7AA; }
    .pill-one {
      display:inline-block; padding:2px 8px; border-radius:999px;
      background:#F97316; color:#fff; font-weight:600; font-size:11px;
    }
  </style>`;
}

// ============ MAIN HANDLER =============

export default async function handler(req, res) {
  try {
    const { period = "daily", today: todayFlag } = req.query;

    const orders = await fetchOrders(period, todayFlag);
    const inventory = await fetchInventoryLevels();

    // Map inventory by item_id
    const invMap = {};
    inventory.forEach((lvl) => {
      invMap[lvl.inventory_item_id] = lvl.available;
    });

    const productRows = [];
    for (const order of orders) {
      for (const line of order.line_items) {
        const id = line.variant_id;
        let row = productRows.find((r) => r.variantId === id);
        if (!row) {
          row = {
            productTitle: line.title,
            variantTitle: line.variant_title || "Default Title",
            sku: line.sku,
            unitPrice: parseFloat(line.price),
            soldQty: 0,
            revenue: 0,
            variantId: id,
            inventoryAvailable: invMap[line.inventory_item_id] ?? 0,
            inventoryIncoming: 0, // placeholder
          };
          productRows.push(row);
        }
        row.soldQty += line.quantity;
        row.revenue += parseFloat(line.price) * line.quantity;
      }
    }

    // Totali
    const totalQty = productRows.reduce((s, r) => s + r.soldQty, 0);
    const totalRevenue = productRows.reduce((s, r) => s + r.revenue, 0);

    // Date label
    const now = DateTime.now().setZone("America/Monterrey");
    let label;
    if (period === "daily") {
      label = todayFlag ? `Hoy ${now.toFormat("dd LLL yyyy")}` : `Ayer ${now.minus({ days: 1 }).toFormat("dd LLL yyyy")}`;
    } else if (period === "weekly") {
      const start = now.startOf("week").toFormat("dd LLL");
      const end = now.endOf("week").toFormat("dd LLL yyyy");
      label = `Semana ${start} – ${end}`;
    } else if (period === "monthly") {
      label = now.toFormat("LLLL yyyy");
    }

    // HTML
    const html = `
      <!DOCTYPE html><html><head><meta charset="utf-8">${baseStyles()}</head>
      <body>
        <h2>Reporte ${period} — ${label}</h2>
        <p><b>Total piezas:</b> ${totalQty} • <b>Ingresos:</b> ${moneyFormat(totalRevenue)}</p>
        ${renderProductsTable(productRows, moneyFormat)}
      </body></html>`;

    res.setHeader("Content-Type", "text/html");
    res.status(200).send(html);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err) });
  }
}
