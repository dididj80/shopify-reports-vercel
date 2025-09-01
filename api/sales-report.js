// /api/sales-report.js
// Report vendite Shopify: daily / weekly / monthly
// Tabella + grafici (POS vs Online, Metodi di pagamento)
// DRYRUN: se REPORT_DRYRUN=true non invia email, logga l’anteprima o mostra l’HTML con ?preview=1

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

const SHOPIFY_GRAPHQL = `https://${SHOP}/admin/api/2024-10/graphql.json`;

// ===================================================================
// Handler
// ===================================================================
export default async function handler(req, res) {
  try {
    // Controllo env minimi
    if (!SHOP || !TOKEN || !TO || !FROM) {
      if (!res.headersSent) {
        return res.status(400).json({ ok: false, error: "Missing env: SHOPIFY_SHOP, SHOPIFY_ADMIN_TOKEN, REPORT_TO_EMAIL, REPORT_FROM_EMAIL" });
      }
      return;
    }

    const url = new URL(req.url, `https://${req.headers.host}`);
    const qsPeriod = (url.searchParams.get("period") || "").toLowerCase();

    // Orario locale per calcolo periodi
    const nowLocal = DateTime.now().setZone(TZ);
    const isMonday = nowLocal.weekday === 1; // lunedì
    const isFirstDay = nowLocal.day === 1;   // giorno 1 del mese

    // Runner di un singolo report (daily/weekly/monthly)
    const runOne = async (p) => {
      const { start, end, rangeLabel } = computeRange(p, nowLocal);
      const startISO = start.toUTC().toISO();
      const endISO = end.toUTC().toISO();

      // 1) Ordini + line items
      const lines = await fetchOrdersWithLines(startISO, endISO);

      // 2) Aggregazione per variante
      const byVariant = new Map();
      for (const li of lines) {
        // fallback se manca variantId: usa SKU o Nome
        const key = li.variantId || (li.sku ? `SKU:${li.sku}` : `NAME:${li.productTitle}__${li.variantTitle}`);
        const prev = byVariant.get(key);
        const unit = li.unitPrice ?? null;
        const rev = li.lineRevenue ?? 0;
        if (prev) {
          prev.soldQty += li.quantity;
          prev.revenue += rev;
          if (unit !== null) prev.unitPrice = unit;
        } else {
          byVariant.set(key, {
            variantId: li.variantId || null,
            productTitle: li.productTitle,
            variantTitle: li.variantTitle || li.productTitle,
            sku: li.sku || "",
            soldQty: li.quantity,
            unitPrice: unit,
            revenue: rev,
            inventoryAvailable: null,
            inventoryIncoming: null, // con 1 location e questa API di solito resta nullo
            locations: []            // non usato nella vista semplificata
          });
        }
      }

      // 3) Inventario totale per variante (API 2024-10)
      const variantIds = Array.from(byVariant.keys())
        .map(k => (k.startsWith("SKU:") || k.startsWith("NAME:")) ? null : k)
        .filter(Boolean);
      if (variantIds.length) {
        const inv = await fetchInventoryForVariants(variantIds);
        for (const it of inv) {
          const rec = byVariant.get(it.variantId);
          if (!rec) continue;
          rec.inventoryAvailable = it.totalAvailable;
          rec.inventoryIncoming = it.totalIncoming; // null nella patch attuale
          rec.locations = it.locations;             // []
        }
      }

      // 4) Totali canali (POS vs ONLINE)
      const channelTotals = { POS: { qty: 0, revenue: 0 }, ONLINE: { qty: 0, revenue: 0 } };
      for (const li of lines) {
        const ch = li.channel;
        channelTotals[ch].qty += li.quantity;
        channelTotals[ch].revenue += li.lineRevenue ?? 0;
      }

      // 5) Metodi di pagamento (ripartizione proporzionale)
      const orderIds = Array.from(new Set(lines.map(l => l.orderId)));
      const txByOrder = await fetchTransactionsForOrders(orderIds);
      const paymentTotals = {}; // gateway -> { qty, revenue }
      for (const li of lines) {
        const txs = txByOrder[li.orderId] || [];
        const sum = txs.reduce((s, t) => s + t.amount, 0);
        if (!sum) {
          (paymentTotals["unknown"] ??= { qty: 0, revenue: 0 }).qty += li.quantity;
          paymentTotals["unknown"].revenue += (li.lineRevenue ?? 0);
          continue;
        }
        for (const t of txs) {
          const share = t.amount / sum;
          (paymentTotals[t.gateway] ??= { qty: 0, revenue: 0 }).qty += li.quantity * share;
          paymentTotals[t.gateway].revenue += (li.lineRevenue ?? 0) * share;
        }
      }

      // 6) Ordinamento righe per vendite poi revenue
      const rows = Array.from(byVariant.values()).sort((a, b) => b.soldQty - a.soldQty || b.revenue - a.revenue);

      // 7) Totali generali
      const totals = {
        qty: rows.reduce((s, r) => s + r.soldQty, 0),
        revenue: rows.reduce((s, r) => s + r.revenue, 0)
      };

      // 8) Render email
      const html = renderEmailHTML({
        period: p,
        rangeLabel,
        rows,
        totals,
        channelTotals,
        paymentTotals,
        money: (n) => new Intl.NumberFormat(LOCALE, { style: "currency", currency: CURRENCY }).format(n)
      });

      // --- PREVIEW: se ?preview=1 e DRYRUN, rispondi HTML e termina
      if (process.env.REPORT_DRYRUN === "true" && url.searchParams.get("preview") === "1") {
        if (!res.headersSent) {
          res.setHeader("Content-Type", "text/html; charset=UTF-8");
          res.status(200).send(html);
        }
        return { sent: true, period: p, items: rows.length };
      }

      // --- DRYRUN: log a console
      if (process.env.REPORT_DRYRUN === "true") {
        console.log("=== DRYRUN ===", p, rangeLabel);
        console.log("Subject:", `Reporte ${periodLabel(p)} — ${rangeLabel}`);
        console.log("HTML preview:\n", html.substring(0, 800), "...");
        return { sent: false, period: p, items: rows.length };
      }

      // --- INVIO reale via Resend ---
      if (!RESEND_KEY) throw new Error("Missing RESEND_API_KEY");
      const resend = new Resend(RESEND_KEY);
      await resend.emails.send({
        from: FROM,
        to: TO,
        subject: `Reporte ${periodLabel(p)} — ${rangeLabel}`,
        html
      });
      return { sent: true, period: p, items: rows.length };
    };

    // Se ?period=... → esegui SOLO quel report
    if (qsPeriod === "daily" || qsPeriod === "weekly" || qsPeriod === "monthly") {
      const out = await runOne(qsPeriod);
      // Se era preview, la risposta è già stata inviata
      if (out.sent && url.searchParams.get("preview") === "1") return;
      if (!res.headersSent) {
        return res.status(200).json({ ok: true, mode: "single", period: out.period, items: out.items });
      }
      return;
    }

    // Modalità AUTO (per usare 1 solo cron): daily + (lunedì) weekly + (1° del mese) monthly
    const results = [];
    const d = await runOne("daily");   results.push({ period: d.period, items: d.items, sent: d.sent });
    if (isMonday)  { const w = await runOne("weekly");  results.push({ period: w.period, items: w.items, sent: w.sent }); }
    if (isFirstDay){ const m = await runOne("monthly"); results.push({ period: m.period, items: m.items, sent: m.sent }); }

    if (!res.headersSent) {
      return res.status(200).json({ ok: true, mode: "auto", results });
    }
    return;
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  }
}

// ===================================================================
// Periodi
// ===================================================================
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

function periodLabel(p) {
  return p === "daily" ? "diario" : p === "weekly" ? "semanal" : "mensual";
}

// ===================================================================
// Shopify fetch helpers
// ===================================================================
async function fetchOrdersWithLines(startISO, endISO) {
  // Filtra ordini PAID nel range
  const q = `financial_status:PAID created_at:>=${startISO} created_at:<=${endISO}`;

  // Paginazione batch
  const pageSize = 100;
  let cursor = null, hasNext = true;
  const out = [];

  while (hasNext) {
    const query = `
      query Orders($q: String!, $cursor: String) {
        orders(first: ${pageSize}, query: $q, after: $cursor, sortKey: CREATED_AT) {
          edges {
            cursor
            node {
              id
              createdAt
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
          pageInfo { hasNextPage }
        }
      }
    `;
    const data = await shopifyGraphQL(query, { q, cursor });
    const edges = data.orders.edges || [];

    for (const e of edges) {
      const orderId = e.node.id;
      const source = (e.node.sourceName || "").toLowerCase() === "pos" ? "POS" : "ONLINE";
      const liEdges = (e.node.lineItems?.edges || []);
      for (const li of liEdges) {
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

    hasNext = data.orders.pageInfo?.hasNextPage;
    cursor = hasNext ? edges[edges.length - 1].cursor : null;
  }

  return out;
}

async function fetchInventoryForVariants(variantIds) {
  // Patch compatibile API 2024-10: usa l'inventario TOTALE della variante
  const chunks = [];
  for (let i = 0; i < variantIds.length; i += 50) chunks.push(variantIds.slice(i, i + 50));
  const out = [];
  for (const ids of chunks) {
    const query = `
      query Variants($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            inventoryQuantity
          }
        }
      }
    `;
    const data = await shopifyGraphQL(query, { ids });
    const nodes = data.nodes || [];
    for (const n of nodes) {
      if (!n) continue;
      out.push({
        variantId: n.id,
        totalAvailable: n.inventoryQuantity ?? null,
        totalIncoming: null,
        locations: []
      });
    }
  }
  return out;
}

async function fetchTransactionsForOrders(orderGids) {
  // REST: /orders/{id}/transactions.json
  const result = {};
  const concurrency = 5;
  const queue = [...orderGids];

  const workers = Array.from({ length: concurrency }, () => (async () => {
    while (queue.length) {
      const gid = queue.shift();
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
      } catch {
        result[gid] = [];
      }
    }
  })());

  await Promise.all(workers);
  return result;
}

async function shopifyGraphQL(query, variables) {
  const res = await fetch(SHOPIFY_GRAPHQL, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

function parseFloatSafe(x) {
  const n = parseFloat(String(x ?? ""));
  return Number.isFinite(n) ? n : NaN;
}

// ===================================================================
// Email rendering
// ===================================================================
function renderEmailHTML({ period, rangeLabel, rows, totals, channelTotals, paymentTotals, money }) {
  const style = `
    <style>
      body { font-family: Inter, Arial, sans-serif; color:#111; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #e5e7eb; padding: 8px; font-size: 13px; vertical-align: top; }
      th { background: #f3f4f6; }
      h2 { margin-bottom: 6px; }
      p { margin: 0 0 10px 0; color:#444; }
      h3 { margin: 14px 0 6px 0; }
    </style>
  `;
  const header = `
    <h2>Reporte ${escapeHtml(periodLabel(period))} — ${escapeHtml(rangeLabel)}</h2>
    <p><strong>Total piezas:</strong> ${totals.qty.toLocaleString("es-MX")} &nbsp;•&nbsp; <strong>Ingresos:</strong> ${money(totals.revenue)}</p>
  `;
  const channelBlock = renderChannelBlock(channelTotals);
  const paymentsBlock = renderPaymentsBlock(paymentTotals, money);
  const table = renderProductsTable(rows, money);
  return `<!doctype html><html><head>${style}</head><body>
    ${header}
    ${channelBlock}
    ${paymentsBlock}
    ${table}
  </body></html>`;
}

function renderProductsTable(rows, money) {
  const head = `
    <thead>
      <tr>
        <th align="left">Producto</th>
        <th align="left">Variante</th>
        <th align="left">SKU</th>
        <th align="right">Precio unitario</th>
        <th align="right">Vendidas</th>
        <th align="right">Ingresos</th>
        <th align="right">Inventario</th>
        <th align="right">En camino</th>
      </tr>
    </thead>
  `;
  const body = rows.map(r => `
      <tr>
        <td>${escapeHtml(r.productTitle)}</td>
        <td>${escapeHtml(r.variantTitle)}</td>
        <td>${escapeHtml(r.sku)}</td>
        <td align="right">${r.unitPrice != null ? money(r.unitPrice) : ""}</td>
        <td align="right">${r.soldQty}</td>
        <td align="right">${money(r.revenue)}</td>
        <td align="right">${r.inventoryAvailable ?? ""}</td>
        <td align="right">${r.inventoryIncoming ?? ""}</td>
      </tr>
    `).join("");
  return `<table>${head}<tbody>${body}</tbody></table>`;
}

function renderChannelBlock(channelTotals) {
  const segQty = [
    { label: "Físicas (POS)", value: channelTotals.POS.qty },
    { label: "Online",        value: channelTotals.ONLINE.qty }
  ];
  const segRev = [
    { label: "Físicas (POS)", value: Math.round(channelTotals.POS.revenue) },
    { label: "Online",        value: Math.round(channelTotals.ONLINE.revenue) }
  ];
  const donutQty = svgDonut(segQty, "Piezas por canal");
  const donutRev = svgDonut(segRev, "Ingresos por canal");
  return `<h3>Canales de venta</h3>${donutQty}${donutRev}`;
}

function renderPaymentsBlock(paymentTotals, money) {
  const entries = Object.entries(paymentTotals).sort((a,b) => b[1].revenue - a[1].revenue);
  const segRev = entries.map(([gw, v]) => ({ label: gatewayLabel(gw), value: Math.round(v.revenue) }));
  const segQty = entries.map(([gw, v]) => ({ label: gatewayLabel(gw), value: Math.round(v.qty) }));
  const donutRev = svgDonut(segRev, "Ingresos por método de pago");
  const donutQty = svgDonut(segQty, "Piezas por método de pago");
  const table = `
    <table style="border-collapse:collapse;width:100%;margin-top:6px;">
      <thead>
        <tr>
          <th align="left" style="border:1px solid #e5e7eb;padding:6px;background:#f3f4f6;">Método</th>
          <th align="right" style="border:1px solid #e5e7eb;padding:6px;background:#f3f4f6;">Piezas</th>
          <th align="right" style="border:1px solid #e5e7eb;padding:6px;background:#f3f4f6;">Ingresos</th>
        </tr>
      </thead>
      <tbody>
        ${entries.map(([gw, v]) => `
          <tr>
            <td style="border:1px solid #e5e7eb;padding:6px;">${escapeHtml(gatewayLabel(gw))}</td>
            <td align="right" style="border:1px solid #e5e7eb;padding:6px;">${Math.round(v.qty).toLocaleString("es-MX")}</td>
            <td align="right" style="border:1px solid #e5e7eb;padding:6px;">${money(v.revenue)}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
  return `<h3>Métodos de pago</h3>${donutRev}${donutQty}${table}`;
}

function gatewayLabel(key) {
  const map = {
    "cash": "Efectivo",
    "manual": "Manual",
    "pos": "POS (Tarjeta)",
    "shopify_payments": "Shopify Payments",
    "paypal": "PayPal",
    "unknown": "Desconocido"
  };
  return map[key] || key;
}

// Donut a colori con legenda e percentuali
function svgDonut(segments, title) {
  const total = segments.reduce((s, x) => s + (x.value || 0), 0) || 1;
  const radius = 40, circumference = 2 * Math.PI * radius;
  let offset = 0;

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
}
