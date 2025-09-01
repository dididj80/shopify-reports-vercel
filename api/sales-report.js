// /api/sales-report.js
// Report vendite Shopify: giornaliero, settimanale, mensile
// Tabella + grafici (POS vs Online, Metodi di pagamento)
// DRYRUN: se REPORT_DRYRUN=true non invia email, logga anteprima

import { DateTime } from "luxon";
import { Resend } from "resend";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const RESEND_KEY = process.env.RESEND_API_KEY;
const TO = process.env.REPORT_TO_EMAIL;
const FROM = process.env.REPORT_FROM_EMAIL;
const CURRENCY = process.env.REPORT_CURRENCY || "MXN";
const LOCALE = process.env.REPORT_LOCALE || "es-MX";
const TZ = "America/Monterrey";

const SHOPIFY_GRAPHQL = `https://${SHOP}/admin/api/2024-10/graphql.json`;

export default async function handler(req, res) {
  try {
    if (!SHOP || !TOKEN || !TO || !FROM) {
      return res.status(400).json({ ok: false, error: "Missing env" });
    }

    const url = new URL(req.url, `https://${req.headers.host}`);
    // Se passi ?period=... funziona come prima; altrimenti entra in AUTO
    const qsPeriod = (url.searchParams.get("period") || "").toLowerCase();

    const nowLocal = DateTime.now().setZone(TZ);
    const isMonday = nowLocal.weekday === 1;    // lunedì = 1
    const isFirstDay = nowLocal.day === 1;      // primo del mese

    // Helper per inviare uno o più report
    const runOne = async (p) => {
      const { start, end, rangeLabel } = computeRange(p, nowLocal);
      const startISO = start.toUTC().toISO();
      const endISO = end.toUTC().toISO();

      const lines = await fetchOrdersWithLines(startISO, endISO);

      const byVariant = new Map();
      for (const li of lines) {
        if (!li.variantId) continue;
        const key = li.variantId;
        const prev = byVariant.get(key);
        const unit = li.unitPrice ?? null;
        const rev = li.lineRevenue ?? 0;
        if (prev) {
          prev.soldQty += li.quantity;
          prev.revenue += rev;
          if (unit !== null) prev.unitPrice = unit;
        } else {
          byVariant.set(key, {
            variantId: key,
            productTitle: li.productTitle,
            variantTitle: li.variantTitle,
            sku: li.sku || "",
            soldQty: li.quantity,
            unitPrice: unit,
            revenue: rev,
            inventoryAvailable: null,
            inventoryIncoming: null,
            locations: []
          });
        }
      }

      const variantIds = Array.from(byVariant.keys());
      if (variantIds.length) {
        const inv = await fetchInventoryForVariants(variantIds);
        for (const it of inv) {
          const rec = byVariant.get(it.variantId);
          if (!rec) continue;
          rec.inventoryAvailable = it.totalAvailable;
          rec.inventoryIncoming = it.totalIncoming;
          rec.locations = it.locations;
        }
      }

      const channelTotals = { POS: { qty: 0, revenue: 0 }, ONLINE: { qty: 0, revenue: 0 } };
      for (const li of lines) {
        const ch = li.channel;
        channelTotals[ch].qty += li.quantity;
        channelTotals[ch].revenue += li.lineRevenue ?? 0;
      }

      const orderIds = Array.from(new Set(lines.map(l => l.orderId)));
      const txByOrder = await fetchTransactionsForOrders(orderIds);
      const paymentTotals = {};
      for (const li of lines) {
        const txs = txByOrder[li.orderId] || [];
        const sum = txs.reduce((s, t) => s + t.amount, 0);
        if (!sum) {
          paymentTotals["unknown"] ??= { qty: 0, revenue: 0 };
          paymentTotals["unknown"].revenue += (li.lineRevenue ?? 0);
          paymentTotals["unknown"].qty += li.quantity;
          continue;
        }
        for (const t of txs) {
          const share = t.amount / sum;
          const revShare = (li.lineRevenue ?? 0) * share;
          const qtyShare = li.quantity * share;
          paymentTotals[t.gateway] ??= { qty: 0, revenue: 0 };
          paymentTotals[t.gateway].revenue += revShare;
          paymentTotals[t.gateway].qty += qtyShare;
        }
      }

      const rows = Array.from(byVariant.values()).sort((a, b) => b.soldQty - a.soldQty || b.revenue - a.revenue);
      const totals = {
        qty: rows.reduce((s, r) => s + r.soldQty, 0),
        revenue: rows.reduce((s, r) => s + r.revenue, 0)
      };

      const html = renderEmailHTML({
        period: p,
        rangeLabel,
        rows,
        totals,
        channelTotals,
        paymentTotals,
        money: (n) => new Intl.NumberFormat(LOCALE, { style: "currency", currency: CURRENCY }).format(n)
      });

	// Se chiedi ?preview=1 in dry-run, ritorna l'HTML completo nel browser
	if (process.env.REPORT_DRYRUN === "true" && url.searchParams.get("preview") === "1") {
  		res.setHeader("Content-Type", "text/html; charset=UTF-8");
 	 	return res.status(200).send(html);
		}
		
      // invio/dryrun
      if (process.env.REPORT_DRYRUN === "true") {
        console.log("=== DRYRUN ===", p, rangeLabel);
        console.log("Subject:", `Reporte ${periodLabel(p)} — ${rangeLabel}`);
        console.log("HTML preview:\n", html.substring(0, 500), "...");
      } else {
        if (!RESEND_KEY) throw new Error("Missing RESEND_API_KEY");
        const resend = new Resend(RESEND_KEY);
        await resend.emails.send({
          from: FROM,
          to: TO,
          subject: `Reporte ${periodLabel(p)} — ${rangeLabel}`,
          html
        });
      }
      return { period: p, items: rows.length };
    };

    // Se ?period=... → comportati come prima (singolo report)
    if (qsPeriod === "daily" || qsPeriod === "weekly" || qsPeriod === "monthly") {
      const out = await runOne(qsPeriod);
      return res.status(200).json({ ok: true, mode: "single", ...out });
    }

    // AUTO: sempre il daily; se lunedì aggiungi weekly; se giorno 1 aggiungi monthly
    const results = [];
    results.push(await runOne("daily"));
    if (isMonday) results.push(await runOne("weekly"));
    if (isFirstDay) results.push(await runOne("monthly"));

    return res.status(200).json({ ok: true, mode: "auto", results });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}

// Utility per calcolare gli intervalli dei periodi
function computeRange(period, nowLocal) {
  if (period === "daily") {
    const yEnd = nowLocal.startOf("day").minus({ seconds: 1 });
    const yStart = yEnd.startOf("day");
    return { start: yStart, end: yEnd, rangeLabel: `Ayer ${yStart.toFormat("dd LLL yyyy")}` };
  }
  if (period === "weekly") {
    const wEnd = nowLocal.startOf("week").minus({ seconds: 1 });
    const wStart = wEnd.startOf("week");
    return { start: wStart, end: wEnd, rangeLabel: `Semana ${wStart.toFormat("dd LLL")} – ${wEnd.toFormat("dd LLL yyyy")}` };
  }
  // monthly
  const mEnd = nowLocal.startOf("month").minus({ seconds: 1 });
  const mStart = mEnd.startOf("month");
  return { start: mStart, end: mEnd, rangeLabel: `Mes ${mStart.toFormat("LLLL yyyy")}` };
}


function periodLabel(p) { return p === "daily" ? "diario" : p === "weekly" ? "semanal" : "mensual"; }

// ---------- Helpers Shopify ----------
async function fetchOrdersWithLines(startISO, endISO) {
  const q = `financial_status:PAID created_at:>=${startISO} created_at:<=${endISO}`;
  const query = `
    query Orders($q: String!) {
      orders(first: 100, query: $q, sortKey: CREATED_AT) {
        edges {
          node {
            id
            sourceName
            lineItems(first: 100) {
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
      }
    }`;
  const data = await shopifyGraphQL(query, { q });
  const out = [];
  for (const e of data.orders.edges) {
    const orderId = e.node.id;
    const source = (e.node.sourceName || "").toLowerCase() === "pos" ? "POS" : "ONLINE";
    for (const li of e.node.lineItems.edges) {
      const unit = parseFloatSafe(li.node?.originalUnitPriceSet?.shopMoney?.amount);
      const lineRev = parseFloatSafe(li.node?.discountedTotalSet?.shopMoney?.amount);
      out.push({
        orderId,
        variantId: li.node?.variant?.id || null,
        variantTitle: li.node?.variant?.title || (li.node?.name || ""),
        productTitle: li.node?.product?.title || "",
        sku: li.node?.sku || null,
        quantity: li.node?.quantity || 0,
        unitPrice: Number.isFinite(unit) ? unit : null,
        lineRevenue: Number.isFinite(lineRev) ? lineRev : 0,
        channel: source
      });
    }
  }
  return out;
}

async function fetchInventoryForVariants(variantIds) {
  const query = `
    query Variants($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          inventoryQuantity
        }
      }
    }`;
  const data = await shopifyGraphQL(query, { ids: variantIds });
  return (data.nodes || []).filter(Boolean).map(n => ({
    variantId: n.id,
    totalAvailable: n.inventoryQuantity ?? null,
    totalIncoming: null,
    locations: [] // non serve con 1 location
  }));
}
async function fetchTransactionsForOrders(orderGids) {
  const result = {};
  for (const gid of orderGids) {
    const numericId = String(gid).split("/").pop();
    const url = `https://${SHOP}/admin/api/2024-10/orders/${numericId}/transactions.json`;
    try {
      const res = await fetch(url, { headers: { "X-Shopify-Access-Token": TOKEN } });
      if (!res.ok) { result[gid] = []; continue; }
      const json = await res.json();
      const txs = (json.transactions || [])
        .filter(t => t.status === "success")
        .map(t => ({ gateway: String(t.gateway || "unknown"), amount: Number(t.amount || 0) }))
        .filter(t => t.amount > 0);
      result[gid] = txs;
    } catch { result[gid] = []; }
  }
  return result;
}

async function shopifyGraphQL(query, variables) {
  const res = await fetch(SHOPIFY_GRAPHQL, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

function parseFloatSafe(x) { const n = parseFloat(String(x ?? "")); return Number.isFinite(n) ? n : NaN; }

// ---------- Email rendering ----------
function renderEmailHTML({ period, rangeLabel, rows, totals, channelTotals, paymentTotals, money }) {
  const style = `
    <style>
      body { font-family: Inter, Arial, sans-serif; color:#111; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #e5e7eb; padding: 6px; font-size: 12px; }
      th { background: #f3f4f6; }
    </style>`;
  const header = `
    <h2>Reporte ${periodLabel(period)} — ${rangeLabel}</h2>
    <p><strong>Total piezas:</strong> ${totals.qty} • <strong>Ingresos:</strong> ${money(totals.revenue)}</p>`;
  const table = renderProductsTable(rows, money);
  return `<!doctype html><html><head>${style}</head><body>
    ${header}
    ${renderChannelBlock(channelTotals)}
    ${renderPaymentsBlock(paymentTotals, money)}
    ${table}
  </body></html>`;
}

function renderProductsTable(rows, money) {
  const head = `<thead><tr>
    <<th>Producto</th><th>Variante</th><th>SKU</th>
	<th>Precio unitario</th><th>Vendidas</th><th>Ingresos</th>
	<th>Inventario</th><th>En camino</th>
  </tr></thead>`;
  const body = rows.map(r => {
    const locs = (r.locations || []).map(l => `${l.name}: ${l.available ?? 0}${l.incoming ? ` (+${l.incoming})` : ""}`).join("<br/>");
    return `<tr>
      <td>${r.productTitle}</td>
      <td>${r.variantTitle}</td>
      <td>${r.sku}</td>
      <td align="right">${r.unitPrice != null ? money(r.unitPrice) : ""}</td>
      <td align="right">${r.soldQty}</td>
      <td align="right">${money(r.revenue)}</td>
      <td align="right">${r.inventoryAvailable ?? ""}</td>
      <td align="right">${r.inventoryIncoming ?? ""}</td>
      <td>${locs}</td>
    </tr>`;
  }).join("");
  return `<table>${head}<tbody>${body}</tbody></table>`;
}

function renderChannelBlock(channelTotals) {
  const seg = [
    { label: "Físicas (POS)", value: channelTotals.POS.qty },
    { label: "Online", value: channelTotals.ONLINE.qty }
  ];
  return `<h3>Canales de venta</h3>${svgDonut(seg, "Piezas por canal")}`;
}

function renderPaymentsBlock(paymentTotals, money) {
  const entries = Object.entries(paymentTotals);
  const seg = entries.map(([gw, v]) => ({ label: gw, value: Math.round(v.qty) }));
  return `<h3>Métodos de pago</h3>${svgDonut(seg, "Piezas por pago")}`;
}

function svgDonut(segments, title) {
  const total = segments.reduce((s, x) => s + (x.value || 0), 0) || 1;
  const radius = 40, circumference = 2 * Math.PI * radius;
  let offset = 0;

  // palette colori (modificabile)
  const colors = ["#2563EB", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#14B8A6"];

  const rings = segments.map((seg, i) => {
    const val = seg.value || 0;
    const frac = val / total;
    const len = frac * circumference;
    const circle = `
      <circle r="${radius}" cx="50" cy="50" fill="transparent"
        stroke="${colors[i % colors.length]}" stroke-width="16"
        stroke-dasharray="${len} ${circumference - len}" stroke-dashoffset="${-offset}" />
    `;
    offset += len;
    return circle;
  }).join("");

  const legend = segments.map((s, i) => {
    const val = s.value || 0;
    const pct = Math.round((val / total) * 100);
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
      <circle r="28" cx="50" cy="50" fill="white"/>
      <text x="50" y="47" text-anchor="middle" font-size="7" fill="#111"
        style="transform:rotate(90deg);transform-origin:50px 50px;">${escapeHtml(title)}</text>
      <text x="50" y="58" text-anchor="middle" font-size="7" fill="#6B7280"
        style="transform:rotate(90deg);transform-origin:50px 50px;">Total ${total.toLocaleString("es-MX")}</text>
    </svg>
    <div style="font-size:12px;color:#111;line-height:1.35">${legend}</div>
  </div>`;
}

