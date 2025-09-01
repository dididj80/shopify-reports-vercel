// /api/sales-report.js
// Report vendite Shopify (daily/weekly/monthly)
// - Tabella vendite per prodotto (Inventario + En camino)
// - Riordini consigliati (velocità su lookback, coverage, ROP, Target, qty consigliata)
// - Metodi di pagamento (con “Pago Mixto”)
// - Grafici a torta in fondo (POS vs Online, Metodi di pagamento)
// - ?preview=1 => mostra HTML; ?debug=1 => blocco debug incoming

import { DateTime } from "luxon";
import { Resend } from "resend";

// ====== ENV ======
const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const RESEND_KEY = process.env.RESEND_API_KEY;
const TO = process.env.REPORT_TO_EMAIL;
const FROM = process.env.REPORT_FROM_EMAIL;
const CURRENCY = process.env.REPORT_CURRENCY || "MXN";
const LOCALE = process.env.REPORT_LOCALE || "es-MX";
const TZ = "America/Monterrey";

// Reordering (configurabili)
const REORDER_LOOKBACK_DAYS = Number(process.env.REORDER_LOOKBACK_DAYS || 30);
const REORDER_LEAD_DAYS     = Number(process.env.REORDER_LEAD_DAYS     || 7);
const REORDER_SAFETY_DAYS   = Number(process.env.REORDER_SAFETY_DAYS   || 3);
const REORDER_REVIEW_DAYS   = Number(process.env.REORDER_REVIEW_DAYS   || 7);
const REORDER_MIN_QTY       = Number(process.env.REORDER_MIN_QTY       || 1);

const REST_INV_VERSION = process.env.SHOPIFY_REST_INV_VERSION || "2024-07";
const SHOPIFY_GRAPHQL = `https://${SHOP}/admin/api/2024-10/graphql.json`;

// ===================================================================
// Handler
// ===================================================================
export default async function handler(req, res) {
  try {
    if (!SHOP || !TOKEN || !TO || !FROM) {
      return res.status(400).json({ ok:false, error:"Missing env vars (SHOPIFY_SHOP, SHOPIFY_ADMIN_TOKEN, REPORT_TO_EMAIL, REPORT_FROM_EMAIL)" });
    }

    const url = new URL(req.url, `https://${req.headers.host}`);
    const PERIOD = (url.searchParams.get("period") || "weekly").toLowerCase();
    const PREVIEW = url.searchParams.get("preview") === "1";
    const DEBUG = url.searchParams.get("debug") === "1";

    const nowLocal = DateTime.now().setZone(TZ);

    // 1) Range del periodo
    const { start, end, rangeLabel } = computeRange(PERIOD, nowLocal);
    const startISO = start.toUTC().toISO();
    const endISO   = end.toUTC().toISO();

    // 2) Ordini del periodo
    const lines = await fetchOrdersWithLines(startISO, endISO);

    // 3) Aggrega per variante
    const byVariant = new Map();
    for (const li of lines) {
      const key = li.variantId || (li.sku ? `SKU:${li.sku}` : `NAME:${li.productTitle}__${li.variantTitle}`);
      const prev = byVariant.get(key);
      if (prev) {
        prev.soldQty += li.quantity;
        prev.revenue += li.lineRevenue ?? 0;
        if (li.unitPrice != null) prev.unitPrice = li.unitPrice;
      } else {
        byVariant.set(key, {
          variantId: li.variantId || null,
          productTitle: li.productTitle,
          variantTitle: li.variantTitle || li.productTitle,
          sku: li.sku || "",
          soldQty: li.quantity,
          unitPrice: li.unitPrice ?? null,
          revenue: li.lineRevenue ?? 0,
          inventoryAvailable: null,
          inventoryIncoming: null,
        });
      }
    }

    // 4) Inventario on-hand + Incoming (inventory levels)
    const variantIds = Array.from(byVariant.keys()).filter(k => !(k.startsWith("SKU:") || k.startsWith("NAME:")));
    let debugIncoming = null;

    if (variantIds.length) {
      // On-hand totale per variante
      const inv = await fetchInventoryForVariants(variantIds);
      for (const v of inv) {
        const rec = byVariant.get(v.variantId);
        if (rec) rec.inventoryAvailable = v.totalAvailable;
      }

      // InventoryItemId (GID) per variante, poi incoming via REST
      const itemMap = await fetchInventoryItemIds(variantIds);
      const incomingByVar = await fetchIncomingForInventoryItems(itemMap); // somma su tutte le location

      for (const [variantId, incoming] of Object.entries(incomingByVar)) {
        const rec = byVariant.get(variantId);
        if (rec) rec.inventoryIncoming = incoming;
      }

      if (DEBUG) {
        debugIncoming = Object.entries(itemMap).map(([variantId, itemGid]) => {
          const num = String(itemGid).split("/").pop();
          return {
            product: byVariant.get(variantId)?.productTitle || "",
            variant: byVariant.get(variantId)?.variantTitle || "",
            variantId,
            inventoryItemId: num,
            incoming: incomingByVar[variantId] || 0,
          };
        });
      }
    }

    // 5) Lookback vendite per velocità
    const lookStartISO = end.minus({ days: REORDER_LOOKBACK_DAYS }).toUTC().toISO();
    const lookLines = await fetchOrdersWithLines(lookStartISO, endISO);
    const lookByVariant = new Map();
    for (const li of lookLines) {
      const key = li.variantId || (li.sku ? `SKU:${li.sku}` : `NAME:${li.productTitle}__${li.variantTitle}`);
      lookByVariant.set(key, (lookByVariant.get(key) || 0) + (li.quantity || 0));
    }

    // 6) Canali + Metodi pagamento
    const channelTotals = { POS:{ qty:0, revenue:0 }, ONLINE:{ qty:0, revenue:0 } };
    for (const li of lines) {
      channelTotals[li.channel].qty += li.quantity;
      channelTotals[li.channel].revenue += li.lineRevenue ?? 0;
    }

    const orderIds = Array.from(new Set(lines.map(x => x.orderId)));
    const txByOrder = await fetchTransactionsForOrders(orderIds);
    const paymentTotals = {};
    for (const li of lines) {
      const txs = txByOrder[li.orderId] || [];
      if (txs.length > 1) {
        (paymentTotals["mixto"] ??= { qty:0, revenue:0 }).qty += li.quantity;
        paymentTotals["mixto"].revenue += li.lineRevenue ?? 0;
      } else if (txs.length === 1) {
        const g = txs[0].gateway || "unknown";
        (paymentTotals[g] ??= { qty:0, revenue:0 }).qty += li.quantity;
        paymentTotals[g].revenue += li.lineRevenue ?? 0;
      } else {
        (paymentTotals["unknown"] ??= { qty:0, revenue:0 }).qty += li.quantity;
        paymentTotals["unknown"].revenue += li.lineRevenue ?? 0;
      }
    }

    // 7) Righe ordinate + totali
    const rows = Array.from(byVariant.values()).sort((a,b) => b.soldQty - a.soldQty || b.revenue - a.revenue);
    const totals = { qty: rows.reduce((s,r)=>s+r.soldQty,0), revenue: rows.reduce((s,r)=>s+r.revenue,0) };

    // 8) Riordini consigliati
    const reorder = computeReorder(rows, lookByVariant);

    // 9) Render
    const html = renderEmailHTML({
      period: PERIOD,
      rangeLabel,
      rows,
      totals,
      reorder,
      channelTotals,
      paymentTotals,
      debugIncoming,
      money: (n) => new Intl.NumberFormat(LOCALE, { style:"currency", currency:CURRENCY }).format(n)
    });

    if (PREVIEW) {
      res.setHeader("Content-Type","text/html; charset=utf-8");
      return res.status(200).send(html);
    }

    if (!RESEND_KEY) {
      return res.status(200).json({ ok:true, items: rows.length, note:"No RESEND_API_KEY, skipped email" });
    }

    const resend = new Resend(RESEND_KEY);
    await resend.emails.send({
      from: FROM,
      to: TO,
      subject: `Reporte ${periodLabel(PERIOD)} — ${rangeLabel}`,
      html
    });

    return res.status(200).json({ ok:true, sent:true, items: rows.length });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok:false, error:String(err?.message || err) });
  }
}

// ===================================================================
// Periodi
// ===================================================================
function computeRange(period, nowLocal) {
  if (period === "daily") {
    const end = nowLocal.startOf("day").minus({ seconds:1 });
    const start = end.startOf("day");
    return { start, end, rangeLabel: `Ayer ${start.toFormat("dd LLL yyyy")}` };
  }
  if (period === "weekly") {
    const end = nowLocal.startOf("week").minus({ seconds:1 });
    const start = end.startOf("week");
    return { start, end, rangeLabel: `Semana ${start.toFormat("dd LLL")} – ${end.toFormat("dd LLL yyyy")}` };
  }
  const end = nowLocal.startOf("month").minus({ seconds:1 });
  const start = end.startOf("month");
  return { start, end, rangeLabel: `Mes ${start.toFormat("LLLL yyyy")}` };
}

function periodLabel(p) {
  return p === "daily" ? "diario" : p === "weekly" ? "semanal" : "mensual";
}

// ===================================================================
// Shopify fetch helpers
// ===================================================================
async function shopifyGraphQL(query, variables) {
  const res = await fetch(SHOPIFY_GRAPHQL, {
    method:"POST",
    headers:{ "X-Shopify-Access-Token": TOKEN, "Content-Type":"application/json" },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

function parseAmount(x) {
  const n = parseFloat(String(x ?? ""));
  return Number.isFinite(n) ? n : 0;
}

async function fetchOrdersWithLines(startISO, endISO) {
  const q = `financial_status:PAID created_at:>=${startISO} created_at:<=${endISO}`;
  let cursor = null, hasNext = true;
  const out = [];

  while (hasNext) {
    const query = `
      query Orders($q:String!, $cursor:String) {
        orders(first:100, after:$cursor, query:$q, sortKey:CREATED_AT) {
          edges {
            cursor
            node {
              id
              sourceName
              lineItems(first:100) {
                edges {
                  node {
                    quantity
                    sku
                    name
                    product { title }
                    variant { id title }
                    originalUnitPriceSet { shopMoney { amount } }
                    discountedTotalSet { shopMoney { amount } }
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    `;
    const data = await shopifyGraphQL(query, { q, cursor });
    const edges = data.orders.edges || [];
    for (const e of edges) {
      const orderId = e.node.id;
      const channel = (e.node.sourceName || "").toLowerCase() === "pos" ? "POS" : "ONLINE";
      for (const li of (e.node.lineItems?.edges || [])) {
        out.push({
          orderId,
          channel,
          variantId: li.node?.variant?.id || null,
          variantTitle: li.node?.variant?.title || "",
          productTitle: li.node?.product?.title || "",
          sku: li.node?.sku || null,
          quantity: li.node?.quantity || 0,
          unitPrice: parseAmount(li.node?.originalUnitPriceSet?.shopMoney?.amount),
          lineRevenue: parseAmount(li.node?.discountedTotalSet?.shopMoney?.amount),
        });
      }
    }
    hasNext = data.orders.pageInfo?.hasNextPage;
    cursor = hasNext ? edges[edges.length-1].cursor : null;
  }

  return out;
}

// Totale on-hand per variante
async function fetchInventoryForVariants(variantIds) {
  const out = [];
  for (let i=0; i<variantIds.length; i+=50) {
    const ids = variantIds.slice(i, i+50);
    const query = `
      query V($ids:[ID!]!) {
        nodes(ids:$ids) {
          ... on ProductVariant { id inventoryQuantity }
        }
      }
    `;
    const data = await shopifyGraphQL(query, { ids });
    for (const n of (data.nodes || [])) {
      if (n) out.push({ variantId: n.id, totalAvailable: n.inventoryQuantity ?? 0 });
    }
  }
  return out;
}

// Mappa variantId -> inventoryItemId (GID)
async function fetchInventoryItemIds(variantIds) {
  const map = {};
  for (let i=0; i<variantIds.length; i+=50) {
    const ids = variantIds.slice(i, i+50);
    const query = `
      query Items($ids:[ID!]!) {
        nodes(ids:$ids) {
          ... on ProductVariant { id inventoryItem { id } }
        }
      }
    `;
    const data = await shopifyGraphQL(query, { ids });
    for (const n of (data.nodes || [])) {
      if (n?.inventoryItem?.id) map[n.id] = n.inventoryItem.id;
    }
  }
  return map;
}

// ID numerici delle location
async function fetchLocationIds() {
  //const url = `https://${SHOP}/admin/api/2024-10/locations.json`;
  const url = `https://${SHOP}/admin/api/${REST_INV_VERSION}/locations.json`;
  const res = await fetch(url, { headers:{ "X-Shopify-Access-Token": TOKEN } });
  if (!res.ok) return [];
  const json = await res.json();
  return (json.locations || []).map(l => String(l.id));
}

// Somma "incoming" per inventory_item_ids, filtrando per location_ids
async function fetchIncomingForInventoryItems(variantIdToItemId) {
  const reverse = {};
  const numericItemIds = [];
  for (const [variantId, itemGid] of Object.entries(variantIdToItemId)) {
    const num = String(itemGid).split("/").pop(); // da GID a numerico
    reverse[num] = variantId;
    numericItemIds.push(num);
  }
  const out = {};
  if (!numericItemIds.length) return out;

  const locs = await fetchLocationIds();
  const locParam = locs.length ? `&location_ids=${encodeURIComponent(locs.join(","))}` : "";

  for (let i=0; i<numericItemIds.length; i+=50) {
    const ids = numericItemIds.slice(i, i+50);
    //const url = `https://${SHOP}/admin/api/2024-10/inventory_levels.json?inventory_item_ids=${encodeURIComponent(ids.join(","))}${locParam}`;
    const url = `https://${SHOP}/admin/api/${REST_INV_VERSION}/inventory_levels.json?inventory_item_ids=${encodeURIComponent(ids.join(","))}${locParam}`;

    const res = await fetch(url, { headers:{ "X-Shopify-Access-Token": TOKEN } });
    if (!res.ok) continue;
    const json = await res.json();
    for (const lvl of (json.inventory_levels || [])) {
      const itemNum = String(lvl.inventory_item_id);
      const variantId = reverse[itemNum];
      if (!variantId) continue;
      out[variantId] = (out[variantId] || 0) + Number(lvl.incoming || 0);
    }
  }
  return out;
}

// Transazioni per ordine (per gateway/misto)
async function fetchTransactionsForOrders(orderGids) {
  const result = {};
  for (const gid of orderGids) {
    const num = String(gid).split("/").pop();
    const url = `https://${SHOP}/admin/api/2024-10/orders/${num}/transactions.json`;
    try {
      const res = await fetch(url, { headers:{ "X-Shopify-Access-Token": TOKEN } });
      if (!res.ok) { result[gid] = []; continue; }
      const json = await res.json();
      result[gid] = (json.transactions || [])
        .filter(t => t.status === "success")
        .map(t => ({ gateway: String(t.gateway || "unknown"), amount: Number(t.amount || 0) }))
        .filter(t => t.amount > 0);
    } catch {
      result[gid] = [];
    }
  }
  return result;
}

// ===================================================================
// Reorder calc
// ===================================================================
function computeReorder(rows, lookByVariant) {
  const need = [];

  for (const r of rows) {
    if (!r.variantId) continue; // senza variant non abbiamo on_hand certo

    const key = r.variantId || (r.sku ? `SKU:${r.sku}` : `NAME:${r.productTitle}__${r.variantTitle}`);
    const soldLook = lookByVariant.get(key) || 0;
    const vel = soldLook / Math.max(REORDER_LOOKBACK_DAYS, 1);  // pezzi/dì (lookback)
    const onHand = Number(r.inventoryAvailable ?? 0);
    const incoming = Number(r.inventoryIncoming ?? 0);

    const coverage = vel > 0 ? onHand / vel : Infinity; // giorni
    const rop = vel * (REORDER_LEAD_DAYS + REORDER_SAFETY_DAYS);
    const target = vel * (REORDER_LEAD_DAYS + REORDER_SAFETY_DAYS + REORDER_REVIEW_DAYS);
    const suggestedRaw = Math.ceil(Math.max(0, target - (onHand + incoming)));
    const suggested = suggestedRaw > 0 ? Math.max(REORDER_MIN_QTY, suggestedRaw) : 0;

    const shouldReorder = (coverage <= (REORDER_LEAD_DAYS + REORDER_SAFETY_DAYS)) || ((onHand + incoming) <= rop);
    if (shouldReorder && suggested > 0) {
      need.push({
        productTitle: r.productTitle,
        variantTitle: r.variantTitle,
        sku: r.sku,
        inventoryAvailable: onHand,
        inventoryIncoming: incoming,
        vel,
        coverage,
        rop,
        target,
        suggested
      });
    }
  }

  // prima quelli che finiscono prima
  need.sort((a,b) => a.coverage - b.coverage);
  return need;
}

// ===================================================================
// Email rendering
// ===================================================================
function renderEmailHTML({ period, rangeLabel, rows, totals, reorder, channelTotals, paymentTotals, debugIncoming, money }) {
  const style = `
  <style>
    body{font-family:Inter,Arial,sans-serif;color:#111}
    table{border-collapse:collapse;width:100%}
    th,td{border:1px solid #e5e7eb;padding:8px;font-size:13px;vertical-align:top}
    th{background:#f3f4f6}
    h2{margin-bottom:6px}
    .muted{color:#6B7280;font-size:12px}
    .spacer{height:16px}
  </style>`;

  const header = `
    <h2>Reporte ${escapeHtml(periodLabel(period))} — ${escapeHtml(rangeLabel)}</h2>
    <p><strong>Total piezas:</strong> ${totals.qty.toLocaleString("es-MX")}
    &nbsp;•&nbsp;<strong>Ingresos:</strong> ${money(totals.revenue)}</p>`;

  const productsTable = renderProductsTable(rows, money);
  const reorderBlock = renderReorderBlock(reorder);
  const paymentsTable = renderPaymentsTable(paymentTotals, money);
  const chartsBlock = renderAllDonuts(channelTotals, paymentTotals);
  const debugBlock = renderDebugIncoming(debugIncoming);

  return `<!doctype html><html><head>${style}</head><body>
    ${header}
    ${productsTable}
    <div class="spacer"></div>
    ${reorderBlock}
    <div class="spacer"></div>
    ${paymentsTable}
    <div class="spacer"></div>
    ${chartsBlock}
    ${debugBlock}
  </body></html>`;
}

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
  const body = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.productTitle)}</td>
      <td>${escapeHtml(r.variantTitle)}</td>
      <td>${escapeHtml(r.sku || "")}</td>
      <td align="right">${r.unitPrice != null ? money(r.unitPrice) : ""}</td>
      <td align="right">${r.soldQty}</td>
      <td align="right">${money(r.revenue)}</td>
      <td align="right">${r.inventoryAvailable ?? ""}</td>
      <td align="right">${r.inventoryIncoming ?? ""}</td>
    </tr>`).join("");
  return `<h3>Ventas por producto</h3><table>${head}<tbody>${body}</tbody></table>`;
}

function renderReorderBlock(list) {
  if (!list || list.length === 0) {
    return `<h3>Riordini consigliati</h3><p class="muted">Nessun articolo critico in base alla copertura.</p>`;
  }
  const rows = list.map(it => `
  <tr>
    <td>${escapeHtml(it.productTitle)}</td>
    <td>${escapeHtml(it.variantTitle)}</td>
    <td>${escapeHtml(it.sku || "")}</td>
    <td align="right">${it.inventoryAvailable}</td>
    <td align="right">${it.inventoryIncoming}</td>
    <td align="right">${it.vel.toFixed(2)}</td>
    <td align="right">${Number.isFinite(it.coverage) ? it.coverage.toFixed(1) : "∞"}</td>
    <td align="right">${Math.ceil(it.rop)}</td>
    <td align="right">${Math.ceil(it.target)}</td>
    <td align="right"><strong>${it.suggested}</strong></td>
  </tr>`).join("");

  return `
  <h3>Riordini consigliati</h3>
  <p class="muted">Finestra vendite: ${REORDER_LOOKBACK_DAYS}gg • Lead: ${REORDER_LEAD_DAYS} • Safety: ${REORDER_SAFETY_DAYS} • Review: ${REORDER_REVIEW_DAYS}</p>
  <table>
    <thead><tr>
      <th align="left">Prodotto</th>
      <th align="left">Variante</th>
      <th align="left">SKU</th>
      <th align="right">On hand</th>
      <th align="right">Incoming</th>
      <th align="right">Vel/dì</th>
      <th align="right">Copertura (gg)</th>
      <th align="right">ROP</th>
      <th align="right">Target</th>
      <th align="right">Qty cons.</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderPaymentsTable(paymentTotals, money) {
  const entries = Object.entries(paymentTotals).sort((a,b)=>b[1].revenue - a[1].revenue);
  const table = `
  <h3>Métodos de pago</h3>
  <table>
    <thead><tr>
      <th align="left">Método</th>
      <th align="right">Piezas</th>
      <th align="right">Ingresos</th>
    </tr></thead>
    <tbody>
      ${entries.map(([gw,v]) => `
        <tr>
          <td>${escapeHtml(gatewayLabel(gw))}</td>
          <td align="right">${Math.round(v.qty).toLocaleString("es-MX")}</td>
          <td align="right">${money(v.revenue)}</td>
        </tr>`).join("")}
    </tbody>
  </table>`;
  return table;
}

// Grafici in fondo (donut con legenda)
function renderAllDonuts(channelTotals, paymentTotals) {
  const segQtyChannel = [
    { label: "Físicas (POS)", value: channelTotals.POS.qty },
    { label: "Online",        value: channelTotals.ONLINE.qty }
  ];
  const segRevChannel = [
    { label: "Físicas (POS)", value: Math.round(channelTotals.POS.revenue) },
    { label: "Online",        value: Math.round(channelTotals.ONLINE.revenue) }
  ];
  const segRevPay = Object.entries(paymentTotals).map(([gw,v]) => ({ label: gatewayLabel(gw), value: Math.round(v.revenue) }));
  const segQtyPay = Object.entries(paymentTotals).map(([gw,v]) => ({ label: gatewayLabel(gw), value: Math.round(v.qty) }));

  const donutQtyChannel = svgDonut(segQtyChannel, "Piezas por canal");
  const donutRevChannel = svgDonut(segRevChannel, "Ingresos por canal");
  const donutRevPay     = svgDonut(segRevPay,     "Ingresos por método de pago");
  const donutQtyPay     = svgDonut(segQtyPay,     "Piezas por método de pago");

  return `<h3>Gráficos</h3>${donutQtyChannel}${donutRevChannel}${donutRevPay}${donutQtyPay}`;
}

function renderDebugIncoming(debugIncoming) {
  if (!debugIncoming || !debugIncoming.length) return "";
  const rows = debugIncoming.map(d => `
    <tr>
      <td>${escapeHtml(d.product)}</td>
      <td>${escapeHtml(d.variant)}</td>
      <td style="font-family:monospace">${escapeHtml(d.variantId.split("/").pop())}</td>
      <td style="font-family:monospace">${escapeHtml(d.inventoryItemId)}</td>
      <td align="right">${d.incoming}</td>
    </tr>`).join("");
  return `
    <h3>DEBUG Incoming (solo con ?debug=1)</h3>
    <table>
      <thead><tr>
        <th align="left">Prodotto</th>
        <th align="left">Variante</th>
        <th align="left">Variant ID</th>
        <th align="left">Inventory Item</th>
        <th align="right">Incoming</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function gatewayLabel(key) {
  const map = {
    "cash": "Efectivo",
    "manual": "Manual",
    "pos": "POS (Tarjeta)",
    "shopify_payments": "Shopify Payments",
    "paypal": "PayPal",
    "fiserv": "Fiserv POS",
    "external_fiserv": "Fiserv POS",
    "mixto": "Pago Mixto",
    "unknown": "Desconocido"
  };
  return map[key] || key;
}

// Donut SVG a colori con legenda
function svgDonut(segments, title) {
  const total = segments.reduce((s,x)=>s+(x.value||0), 0) || 1;
  const radius = 40, circumference = 2 * Math.PI * radius;
  let offset = 0;
  const colors = ["#2563EB","#10B981","#F59E0B","#EF4444","#8B5CF6","#14B8A6"];

  const rings = segments.map((seg,i)=>{
    const val = seg.value || 0;
    const len = (val/total) * circumference;
    const circle = `
      <circle r="${radius}" cx="50" cy="50" fill="transparent"
        stroke="${colors[i % colors.length]}" stroke-width="16"
        stroke-dasharray="${len} ${circumference - len}" stroke-dashoffset="${-offset}" />`;
    offset += len;
    return circle;
  }).join("");

  const legend = segments.map((s,i)=>{
    const val = s.value || 0;
    const pct = Math.round((val/total)*100);
    return `
      <div style="display:flex;align-items:center;margin:2px 0;">
        <span style="width:10px;height:10px;display:inline-block;background:${colors[i % colors.length]};margin-right:6px;border-radius:2px;"></span>
        <span>${escapeHtml(String(s.label))}: <strong>${val.toLocaleString("es-MX")}</strong> (${pct}%)</span>
      </div>`;
  }).join("");

  return `
  <div style="display:flex;gap:16px;align-items:center;margin:8px 0 12px 0;">
    <svg width="140" height="140" viewBox="0 0 100 100" style="transform:rotate(-90deg);">
      <circle r="${radius}" cx="50" cy="50" fill="transparent" stroke="#E5E7EB" stroke-width="16"/>
      ${rings}
      <circle r="${radius - 12}" cx="50" cy="50" fill="white"/>
      <text x="50" y="47" text-anchor="middle" font-size="7" fill="#111"
        style="transform:rotate(90deg);transform-origin:50px 50px;">${escapeHtml(title)}</text>
      <text x="50" y="58" text-anchor="middle" font-size="7" fill="#6B7280"
        style="transform:rotate(90deg);transform-origin:50px 50px;">Total ${total.toLocaleString("es-MX")}</text>
    </svg>
    <div style="font-size:12px;color:#111;line-height:1.35">${legend}</div>
  </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
}
