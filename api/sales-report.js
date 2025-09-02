// /api/sales-report.js
import { DateTime } from "luxon";

const SHOP  = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

const REST = (p, ver = "2024-07") => `https://${SHOP}/admin/api/${ver}${p}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const money = (n) => new Intl.NumberFormat("es-MX",{style:"currency",currency:"MXN"}).format(Number(n||0));

async function fetchWithHeaders(url) {
  const r = await fetch(url, { headers: { "X-Shopify-Access-Token": TOKEN } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${text}`.slice(0, 500));
  return { json: text ? JSON.parse(text) : {}, link: r.headers.get("link") || "" };
}
async function shopFetchJson(url) { const { json } = await fetchWithHeaders(url); return json; }

async function getShopTZ() {
  const { shop } = await shopFetchJson(REST("/shop.json"));
  return shop.iana_timezone || shop.timezone || "UTC";
}

async function computeRange(period, todayFlag) {
  const tz = await getShopTZ();
  const now = DateTime.now().setZone(tz);
  let start, end;
  if (period === "daily") {
    if (todayFlag) { start = now.startOf("day"); end = now.endOf("day"); }
    else { const y = now.minus({days:1}); start = y.startOf("day"); end = y.endOf("day"); }
  } else if (period === "weekly") {
    start = now.startOf("week"); end = now.endOf("week");
  } else {
    start = now.startOf("month"); end = now.endOf("month");
  }
  return { tz, now, start, end };
}

// ------- Orders (paid + pagination) -------
async function fetchOrdersPaidInRange(start, end) {
  const base =
    `/orders.json?status=any&financial_status=paid&limit=250` +
    `&created_at_min=${encodeURIComponent(start.toUTC().toISO())}` +
    `&created_at_max=${encodeURIComponent(end.toUTC().toISO())}`;

  let url = REST(base);
  const out = [];
  for (;;) {
    const { json, link } = await fetchWithHeaders(url);
    out.push(...(json.orders || []));
    const next = parseNext(link);
    if (!next) break;
    url = REST(`/orders.json?${next}`);
  }
  return out;

  function parseNext(linkHeader) {
    // Link: <...page_info=XYZ>; rel="next"
    if (!linkHeader) return null;
    const m = linkHeader.split(",").map(s=>s.trim()).find(s=>/rel="next"/.test(s));
    if (!m) return null;
    const u = m.match(/<([^>]+)>/);
    if (!u) return null;
    const qs = new URL(u[1]).search; // includes '?'
    // Shopify vuole solo i parametri dopo '?'
    return qs.replace(/^\?/, "");
  }
}

// ------- Variants & Inventory -------
const chunk = (arr, n) => Array.from({length: Math.ceil(arr.length/n)}, (_,i)=>arr.slice(i*n,(i+1)*n));

async function fetchVariantsByIds(variantIds) {
  const ids = [...new Set(variantIds.filter(Boolean))];
  const out = new Map();
  for (const c of chunk(ids, 50)) {
    const { variants } = await shopFetchJson(REST(`/variants.json?ids=${encodeURIComponent(c.join(","))}`));
    for (const v of variants || []) {
      out.set(String(v.id), {
        inventory_item_id: v.inventory_item_id,
        inventory_quantity: v.inventory_quantity,
        inventory_management: v.inventory_management || "",
        sku: v.sku || "",
      });
    }
  }
  return out;
}

async function fetchInventoryLevelsForItems(itemIds) {
  const ids = [...new Set(itemIds.filter(Boolean).map(String))];
  const res = Object.create(null);
  for (const c of chunk(ids, 50)) {
    const { inventory_levels } = await shopFetchJson(REST(`/inventory_levels.json?inventory_item_ids=${encodeURIComponent(c.join(","))}`));
    for (const lvl of inventory_levels || []) {
      const key = String(lvl.inventory_item_id);
      res[key] = (res[key] || 0) + Number(lvl.available ?? 0);
    }
  }
  return res;
}

// ------- Donut charts -------
const PALETTE = ["#2563EB","#10B981","#F59E0B","#EF4444","#8B5CF6","#06B6D4","#84CC16","#F43F5E"];
function donutSVG(parts, size=120) {
  const total = parts.reduce((s,p)=>s+p.value,0) || 1;
  const r = size/2 - 6, cx=size/2, cy=size/2, w=16;
  let a0 = -Math.PI/2, segs="";
  parts.forEach((p, i)=>{
    const a1 = a0 + (p.value/total)*Math.PI*2;
    const x0 = cx + r*Math.cos(a0), y0 = cy + r*Math.sin(a0);
    const x1 = cx + r*Math.cos(a1), y1 = cy + r*Math.sin(a1);
    const large = (a1-a0) > Math.PI ? 1 : 0;
    const path = `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} L ${cx + (r-w)*Math.cos(a1)} ${cy + (r-w)*Math.sin(a1)} A ${r-w} ${r-w} 0 ${large} 0 ${cx + (r-w)*Math.cos(a0)} ${cy + (r-w)*Math.sin(a0)} Z`;
    segs += `<path d="${path}" fill="${PALETTE[i%PALETTE.length]}" />`;
    a0 = a1;
  });
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${segs}</svg>`;
}

function humanLabel(k) {
  const m = { pos: "POS", web: "Online", online: "Online", shopify: "Online" };
  return m[k] || k;
}
function classPaymentGroup(gws) {
  const set = new Set((gws||[]).map(s=>s.toLowerCase()));
  const hasCash   = [...set].some(s=>s.includes("cash") || s.includes("efectivo"));
  const hasFiserv = [...set].some(s=>s.includes("fiserv") || s.includes("pos"));
  if (hasCash && hasFiserv) return "Mixto cash+POS";
  if (hasCash) return "Cash";
  if (hasFiserv) return "Card POS";
  return "Online";
}

function chartsHTML(orders) {
  const pieces = (o) => o.line_items.reduce((s,li)=>s+Number(li.quantity||0),0);

  // 1) per canale (source_name)
  const chObj = {};
  for (const o of orders) {
    const ch = (o.source_name || o.channel || "desconocido").toLowerCase();
    chObj[ch] = (chObj[ch]||0) + pieces(o);
  }

  // 2) per gateway
  const payObj = {};
  for (const o of orders) {
    for (const g of (o.payment_gateway_names||[])) {
      const k = g.toLowerCase();
      payObj[k] = (payObj[k]||0) + pieces(o);
    }
  }

  // 3) POS vs Online
  const posVsOnline = { POS:0, Online:0 };
  for (const o of orders) {
    const isPOS = (o.source_name || "").toLowerCase()==="pos" || !!o.location_id;
    posVsOnline[ isPOS ? "POS" : "Online" ] += pieces(o);
  }

  // 4) Gruppi pagamento (Cash / Card POS / Mix / Online)
  const grpObj = {};
  for (const o of orders) {
    const grp = classPaymentGroup(o.payment_gateway_names);
    grpObj[grp] = (grpObj[grp]||0) + pieces(o);
  }

  const top = (obj) => Object.entries(obj).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>({label:humanLabel(k), value:v}));

  const sections = [
    { title:"Canales de venta", parts: top(chObj) },
    { title:"Métodos de pago (gateway)", parts: top(payObj) },
    { title:"POS vs Online", parts: Object.entries(posVsOnline).map(([k,v])=>({label:k,value:v})) },
    { title:"Tipo de pago (Cash/Card POS/Mixto/Online)", parts: top(grpObj) },
  ];

  return `
  <div style="display:grid;grid-template-columns:repeat(2,minmax(220px,1fr));gap:24px;margin:8px 0 16px">
    ${sections.map(sec => `
      <div>
        <div class="muted">${esc(sec.title)}</div>
        ${donutSVG(sec.parts)}
        <div class="muted" style="margin-top:6px">
          ${sec.parts.map((p,i)=>`
            <div><span style="display:inline-block;width:10px;height:10px;background:${PALETTE[i%PALETTE.length]};margin-right:6px;border-radius:2px"></span>${esc(p.label)}: ${p.value}</div>
          `).join("")}
        </div>
      </div>
    `).join("")}
  </div>`;
}

// ------- ROP -------
function computeROP({sales30d, onHand, leadDays=7, safetyDays=3}) {
  const vel = Math.max(0, sales30d/30);
  const rop = Math.ceil(vel*(leadDays+safetyDays));
  const target = Math.ceil(vel*(leadDays+safetyDays+14));
  const coverage = vel>0 ? (onHand/vel) : Infinity;
  const qty = Math.max(0, target - onHand);
  return { vel, rop, target, qty, coverage };
}

// ------- Styles & Tables -------
function styles() {
  return `
  <style>
    body{font-family:Inter,Arial,sans-serif;color:#111}
    table{border-collapse:collapse;width:100%}
    th,td{border:1px solid #e5e7eb;padding:8px;font-size:13px;vertical-align:top}
    th{background:#f3f4f6}
    h2{margin-bottom:6px}
    .muted{color:#6B7280;font-size:12px}
    .row-zero{background:#FEF2F2} .row-zero td{border-color:#FECACA}
    .row-one{background:#FFF7ED}  .row-one td{border-color:#FED7AA}
    .pill-zero,.pill-one{display:inline-block;padding:2px 8px;border-radius:999px;color:#fff;font-weight:700;font-size:11px}
    .pill-zero{background:#DC2626}.pill-one{background:#F97316}
  </style>`;
}

function renderProductsTable(rows) {
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
  const body = rows.map(r=>{
    const inv = Number(r.inventoryAvailable ?? 0);
    const cls = inv===0 ? ' class="row-zero"' : (inv===1 ? ' class="row-one"' : "");
    const invCell = inv===0 ? '<span class="pill-zero">0</span>'
               : inv===1 ? '<span class="pill-one">1</span>'
               : String(inv);
    return `
      <tr${cls}>
        <td>${esc(r.productTitle)}</td>
        <td>${esc(r.variantTitle)}</td>
        <td>${esc(r.sku||"")}</td>
        <td align="right">${r.unitPrice!=null?esc(money(r.unitPrice)):""}</td>
        <td align="right">${r.soldQty}</td>
        <td align="right">${esc(money(r.revenue))}</td>
        <td align="right">${invCell}</td>
        <td align="right">${r.incoming ?? 0}</td>
      </tr>`;
  }).join("");
  return `<h3>Ventas por producto</h3><table>${head}<tbody>${body}</tbody></table>`;
}

function renderROPTable(rows) {
  if (!rows.length) return "";
  const head = `
  <thead><tr>
    <th align="left">Prodotto</th>
    <th align="left">Variante</th>
    <th align="left">SKU</th>
    <th align="right">On hand</th>
    <th align="right">Incoming</th>
    <th align="right">Vendite 30gg</th>
    <th align="right">Vel/di</th>
    <th align="right">Copertura (gg)</th>
    <th align="right">ROP</th>
    <th align="right">Target</th>
    <th align="right">Qty cons.</th>
  </tr></thead>`;
  const body = rows.map(r=>`
    <tr>
      <td>${esc(r.productTitle)}</td>
      <td>${esc(r.variantTitle)}</td>
      <td>${esc(r.sku||"")}</td>
      <td align="right">${r.onHand ?? ""}</td>
      <td align="right">${r.incoming ?? 0}</td>
      <td align="right">${r.sales30d}</td>
      <td align="right">${r.vel.toFixed(2)}</td>
      <td align="right">${Number.isFinite(r.coverage)?r.coverage.toFixed(1):"∞"}</td>
      <td align="right">${r.rop}</td>
      <td align="right">${r.target}</td>
      <td align="right"><b>${r.qty}</b></td>
    </tr>`).join("");
  return `<h3>Riordini consigliati</h3><div class="muted">Finestra vendite: 30gg • Lead: 7 • Safety: 3</div><table>${head}<tbody>${body}</tbody></table>`;
}

function renderDebug(rows, tz) {
  const head = `<thead><tr><th>Producto</th><th>Variante</th><th>Variant ID</th><th>Inventory Item</th><th>Available</th></tr></thead>`;
  const body = rows.map(r=>`<tr><td>${esc(r.productTitle)}</td><td>${esc(r.variantTitle)}</td><td>${r.variantId||""}</td><td>${r.inventory_item_id||""}</td><td>${r.inventoryAvailable??""}</td></tr>`).join("");
  return `<h3>DEBUG (solo con ?debug=1)</h3><div class="muted">TZ: ${esc(tz)}</div><table>${head}<tbody>${body}</tbody></table>`;
}

// ------- Handler -------
export default async function handler(req, res) {
  try {
    const period = (req.query.period || "daily").toLowerCase(); // daily|weekly|monthly
    const today  = req.query.today === "1";
    const debug  = req.query.debug === "1";

    const { tz, now, start, end } = await computeRange(period, today);

    // 1) ordini pagati nel range (con pagination)
    const orders = await fetchOrdersPaidInRange(start, end);

    // 2) righe prodotto
    const byVariant = new Map();
    const variantIds = new Set();
    for (const o of orders) {
      for (const li of o.line_items || []) {
        const key = li.variant_id ?? `SKU:${li.sku || li.title}`;
        const prev = byVariant.get(key) || {
          productTitle: li.title, variantTitle: li.variant_title || "Default Title",
          sku: li.sku || "", unitPrice: Number(li.price || 0),
          soldQty: 0, revenue: 0,
          variantId: li.variant_id || null,
          inventory_item_id: li.inventory_item_id || null,
          inventoryAvailable: null, incoming: 0,
        };
        prev.soldQty += Number(li.quantity || 0);
        prev.revenue += Number(li.price || 0) * Number(li.quantity || 0);
        byVariant.set(key, prev);
        if (li.variant_id) variantIds.add(li.variant_id);
      }
    }
    const rows = Array.from(byVariant.values()).sort((a,b)=>b.soldQty-a.soldQty||b.revenue-a.revenue);

    // 3) variant → inventory_item_id (+ fallback qty)
    const variantInfo = await fetchVariantsByIds([...variantIds]);
    for (const r of rows) {
      const info = r.variantId ? variantInfo.get(String(r.variantId)) : null;
      if (info && !r.inventory_item_id) r.inventory_item_id = info.inventory_item_id || null;
      r._variantFallbackQty = info ? info.inventory_quantity : null;
      r._variantMgmt        = info ? info.inventory_management : "";
    }

    // 4) inventory levels per item id
    const itemIds = rows.map(r=>r.inventory_item_id).filter(Boolean);
    const invLevels = await fetchInventoryLevelsForItems(itemIds);
    for (const r of rows) {
      const iid = r.inventory_item_id ? String(r.inventory_item_id) : null;
      if (iid && invLevels[iid] != null) {
        r.inventoryAvailable = invLevels[iid];
      } else if (r._variantMgmt !== "shopify" && r._variantFallbackQty != null) {
        r.inventoryAvailable = r._variantFallbackQty;
      } else {
        r.inventoryAvailable = 0;
      }
    }

    // 5) vendite 30gg per ROP
    const start30 = now.minus({days:30}).startOf("day");
    const orders30 = await fetchOrdersPaidInRange(start30, now.endOf("day"));
    const sales30 = new Map();
    for (const o of orders30) for (const li of o.line_items||[]) {
      const k = li.variant_id || `SKU:${li.sku||li.title}`;
      sales30.set(k, (sales30.get(k)||0) + Number(li.quantity||0));
    }
    const ropRows = rows.map(r=>{
      const sales30d = sales30.get(r.variantId ?? `SKU:${r.sku||r.productTitle}`) || 0;
      const c = computeROP({ sales30d, onHand: Number(r.inventoryAvailable||0), leadDays:7, safetyDays:3 });
      return { ...r, onHand:Number(r.inventoryAvailable||0), sales30d,
        vel:c.vel, rop:c.rop, target:c.target, qty:c.qty, coverage:c.coverage };
    }).filter(r=> r.qty>0 || r.onHand<=1);

    // Totali e label
    const totQty = rows.reduce((s,r)=>s+r.soldQty,0);
    const totRev = rows.reduce((s,r)=>s+r.revenue,0);
    const label =
      period==="daily"  ? `${today ? "Hoy" : "Ayer"} ${start.toFormat("dd LLL yyyy")}` :
      period==="weekly" ? `Semana ${start.toFormat("dd LLL")} – ${end.toFormat("dd LLL yyyy")}` :
                          `Mes ${start.toFormat("LLLL yyyy")}`;

    const html = `<!doctype html><html><head><meta charset="utf-8">${styles()}</head><body>
      <h2>Reporte ${period} — ${esc(label)} <span class="muted">(TZ: ${esc(tz)})</span></h2>
      <p><b>Total piezas:</b> ${totQty.toLocaleString("es-MX")} • <b>Ingresos:</b> ${esc(money(totRev))}</p>

      ${chartsHTML(orders)}

      ${renderProductsTable(rows)}
      <div style="height:16px"></div>
      ${renderROPTable(ropRows)}

      ${debug ? `<div style="height:16px"></div>${renderDebug(rows, tz)}` : ""}
    </body></html>`;

    res.setHeader("Content-Type","text/html; charset=utf-8");
    res.status(200).send(html);
  } catch (err) {
    console.error("sales-report error:", err);
    res.status(500).json({ ok:false, error: String(err.message||err) });
  }
}
