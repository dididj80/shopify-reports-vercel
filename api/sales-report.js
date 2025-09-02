// /api/sales-report.js
// Evidenziazione inventario: 0 rosso, 1 arancione. Range calcolati nel fuso del negozio.

import { DateTime } from "luxon";

// === ENV ===
const SHOP  = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// === Utils ===
const REST = (p, ver = "2024-07") => `https://${SHOP}/admin/api/${ver}${p}`;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
const fmtMoney = (n) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(Number(n||0));

// === Shopify helpers ===
async function shopFetchJson(url) {
  const r = await fetch(url, { headers: { "X-Shopify-Access-Token": TOKEN } });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${url} -> ${r.status} ${text}`.slice(0, 500));
  }
  return r.json();
}

// Fuso orario reale del negozio
async function getShopTZ() {
  const { shop } = await shopFetchJson(REST("/shop.json"));
  return shop.iana_timezone || shop.timezone || "UTC";
}

// Calcolo range [start, end] (end incluso per REST) nel fuso del negozio
async function computeRange(period, todayFlag) {
  const tz = await getShopTZ();
  const now = DateTime.now().setZone(tz);
  let start, end;
  if (period === "daily") {
    if (todayFlag) {
      start = now.startOf("day");
      end   = now.endOf("day");
    } else {
      const y = now.minus({ days: 1 });
      start = y.startOf("day");
      end   = y.endOf("day");
    }
  } else if (period === "weekly") {
    start = now.startOf("week");
    end   = now.endOf("week");
  } else {
    // monthly
    start = now.startOf("month");
    end   = now.endOf("month");
  }
  return { tz, start, end };
}

// === Data ===
async function fetchOrders(period, todayFlag) {
  if (!SHOP || !TOKEN) throw new Error("Missing SHOPIFY_SHOP or SHOPIFY_ADMIN_TOKEN");

  const { tz, start, end } = await computeRange(period, todayFlag);

  const url = REST(
    `/orders.json?status=any&limit=250` +
      `&created_at_min=${encodeURIComponent(start.toUTC().toISO())}` +
      `&created_at_max=${encodeURIComponent(end.toUTC().toISO())}`
  );

  // NB: per semplicità prendo al massimo 250 ordini; se ti serve la paginazione la aggiungiamo.
  const { orders } = await shopFetchJson(url);
  return { tz, start, end, orders: orders || [] };
}

async function fetchInventoryLevels() {
  // Ritorna tutti i livelli; ci serve solo available per inventory_item_id
  const { inventory_levels } = await shopFetchJson(REST(`/inventory_levels.json?limit=250`));
  const map = Object.create(null);
  for (const lvl of inventory_levels || []) {
    const key = String(lvl.inventory_item_id);
    // sommo tra location diverse
    map[key] = (map[key] || 0) + Number(lvl.available ?? 0);
  }
  return map;
}

// === HTML ===
function styles() {
  return `
  <style>
    body{font-family:Inter,Arial,sans-serif;color:#111}
    table{border-collapse:collapse;width:100%}
    th,td{border:1px solid #e5e7eb;padding:8px;font-size:13px;vertical-align:top}
    th{background:#f3f4f6}
    h2{margin-bottom:6px}
    .muted{color:#6B7280;font-size:12px}
    .spacer{height:16px}

    /* evidenziazioni inventario */
    .row-zero  { background:#FEF2F2; }  /* rosso chiaro */
    .row-zero td { border-color:#FECACA; }
    .pill-zero {
      display:inline-block;padding:2px 8px;border-radius:999px;
      background:#DC2626;color:#fff;font-weight:700;font-size:11px;
    }
    .row-one   { background:#FFF7ED; }  /* arancione chiaro */
    .row-one td { border-color:#FED7AA; }
    .pill-one  {
      display:inline-block;padding:2px 8px;border-radius:999px;
      background:#F97316;color:#fff;font-weight:700;font-size:11px;
    }
  </style>`;
}

function renderTable(rows) {
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

  const body = rows.map(r => {
    const inv = Number(r.inventoryAvailable ?? 0);
    const cls = inv === 0 ? ' class="row-zero"' : (inv === 1 ? ' class="row-one"' : "");
    const invCell = inv === 0 ? '<span class="pill-zero">0</span>'
                : inv === 1 ? '<span class="pill-one">1</span>'
                : String(inv);
    return `
      <tr${cls}>
        <td>${esc(r.productTitle)}</td>
        <td>${esc(r.variantTitle)}</td>
        <td>${esc(r.sku || "")}</td>
        <td align="right">${r.unitPrice != null ? esc(fmtMoney(r.unitPrice)) : ""}</td>
        <td align="right">${r.soldQty}</td>
        <td align="right">${esc(fmtMoney(r.revenue))}</td>
        <td align="right">${invCell}</td>
        <td align="right">${r.inventoryIncoming ?? ""}</td>
      </tr>`;
  }).join("");

  return `<h3>Ventas por producto</h3><table>${head}<tbody>${body}</tbody></table>`;
}

// === Handler ===
export default async function handler(req, res) {
  try {
    const period = (req.query.period || "daily").toLowerCase(); // daily|weekly|monthly
    const today  = req.query.today === "1";

    // 1) Ordini nel range (fuso negozio)
    const { tz, start, end, orders } = await fetchOrders(period, today);

    // 2) Inventario disponibile per inventory_item_id
    const invMap = await fetchInventoryLevels();

    // 3) Aggregazione righe per variante
    const byVariant = new Map();
    for (const o of orders) {
      for (const li of o.line_items || []) {
        const key = li.variant_id ?? `SKU:${li.sku || li.title}`;
        const prev = byVariant.get(key) || {
          productTitle: li.title,
          variantTitle: li.variant_title || "Default Title",
          sku: li.sku || "",
          unitPrice: Number(li.price ?? 0),
          soldQty: 0,
          revenue: 0,
          inventoryAvailable: invMap[String(li.inventory_item_id)] ?? 0,
          inventoryIncoming: 0,
        };
        prev.soldQty += Number(li.quantity || 0);
        prev.revenue += Number(li.price || 0) * Number(li.quantity || 0);
        byVariant.set(key, prev);
      }
    }
    const rows = Array.from(byVariant.values())
      .sort((a,b)=> b.soldQty - a.soldQty || b.revenue - a.revenue);

    const totals = {
      qty: rows.reduce((s,r)=>s+r.soldQty,0),
      rev: rows.reduce((s,r)=>s+r.revenue,0),
    };

    const label =
      period === "daily"
        ? `${today ? "Hoy" : "Ayer"} ${ (today ? start : start).toFormat("dd LLL yyyy") }`
        : period === "weekly"
        ? `Semana ${start.toFormat("dd LLL")} – ${end.toFormat("dd LLL yyyy")}`
        : `Mes ${start.toFormat("LLLL yyyy")}`;

    const html = `<!doctype html><html><head><meta charset="utf-8">${styles()}</head><body>
      <h2>Reporte ${period} — ${esc(label)} <span class="muted">(TZ: ${esc(tz)})</span></h2>
      <p><b>Total piezas:</b> ${totals.qty.toLocaleString("es-MX")} •
         <b>Ingresos:</b> ${esc(fmtMoney(totals.rev))}</p>
      ${renderTable(rows)}
    </body></html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  } catch (e) {
    console.error("sales-report error:", e);
    return res.status(500).json({ ok:false, error:String(e.message || e) });
  }
}
