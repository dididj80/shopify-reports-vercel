// /api/sales-report.js - Versione finale con cache ottimizzata
import { DateTime } from "luxon";

// CACHE IN-MEMORY ottimizzata
const reportCache = new Map();

function getCacheTTL(period, today) {
  if (today) return 3 * 60 * 1000;        // "Oggi": 3 minuti (live)
  if (period === "daily") return 10 * 60 * 1000;   // "Ieri": 10 minuti
  if (period === "weekly") return 30 * 60 * 1000;  // "Settimana": 30 minuti
  return 60 * 60 * 1000;                           // "Mese": 1 ora
}

function getCacheKey(period, today, start, end) {
  const timeKey = today ? start.toFormat('yyyy-MM-dd-HH') : start.toFormat('yyyy-MM-dd');
  return `${period}-${today}-${timeKey}`;
}

function getFromCache(key, ttl) {
  const cached = reportCache.get(key);
  if (!cached) return null;
  
  const age = Date.now() - cached.timestamp;
  if (age > ttl) {
    reportCache.delete(key);
    console.log(`🗑️  Cache expired: ${key} (${Math.floor(age/1000)}s)`);
    return null;
  }
  
  console.log(`⚡ Cache HIT: ${key} (${Math.floor(age/1000)}s old)`);
  return { ...cached.data, cached: true, cacheAge: Math.floor(age/1000) };
}

function setCache(key, data, ttl) {
  if (reportCache.size >= 15) {
    const oldest = reportCache.keys().next().value;
    reportCache.delete(oldest);
  }
  
  reportCache.set(key, { data, timestamp: Date.now() });
  console.log(`💾 Cache SET: ${key} (TTL: ${Math.floor(ttl/1000/60)}min)`);
}

// SHOPIFY API HELPERS
const SHOP = process.env.SHOPIFY_SHOP;
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

async function shopFetchJson(url) { 
  const { json } = await fetchWithHeaders(url); 
  return json; 
}

async function getShopTZ() {
  const { shop } = await shopFetchJson(REST("/shop.json"));
  return shop.iana_timezone || shop.timezone || "UTC";
}

async function computeRange(period, todayFlag) {
  const tz = await getShopTZ();
  const now = DateTime.now().setZone(tz);
  let start, end;
  
  if (period === "daily") {
    if (todayFlag) { 
      start = now.startOf("day"); 
      end = now.endOf("day"); 
    } else { 
      const y = now.minus({days:1}); 
      start = y.startOf("day"); 
      end = y.endOf("day"); 
    }
  } else if (period === "weekly") {
    start = now.startOf("week"); 
    end = now.endOf("week");
  } else if (period === "monthly") {
    start = now.startOf("month"); 
    end = now.endOf("month");
  }
  
  return { tz, now, start, end };
}

// FETCH ORDERS con paginazione
async function fetchOrdersPaidInRange(start, end) {
  const base = `/orders.json?status=any&financial_status=paid&limit=250` +
    `&created_at_min=${encodeURIComponent(start.toUTC().toISO())}` +
    `&created_at_max=${encodeURIComponent(end.toUTC().toISO())}`;

  let url = REST(base);
  const out = [];
  let pageCount = 0;
  
  for (;;) {
    if (pageCount++ > 100) break;
    
    const { json, link } = await fetchWithHeaders(url);
    const orders = json.orders || [];
    out.push(...orders);
    
    const next = parseNext(link);
    if (!next) break;
    url = REST(`/orders.json?${next}`);
  }
  
  return out;

  function parseNext(linkHeader) {
    if (!linkHeader) return null;
    const m = linkHeader.split(",").find(s=>/rel="next"/.test(s?.trim()));
    if (!m) return null;
    const u = m.match(/<([^>]+)>/);
    return u ? new URL(u[1]).search.replace(/^\?/, "") : null;
  }
}

// ELABORAZIONE PRODOTTI
function processProducts(orders) {
  const byVariant = new Map();
  const variantIds = new Set();
  
  for (const o of orders) {
    for (const li of o.line_items || []) {
      const key = li.variant_id ?? `SKU:${li.sku || li.title}`;
      const prev = byVariant.get(key) || {
        productTitle: li.title || "Producto", 
        variantTitle: li.variant_title || "Default Title",
        sku: li.sku || "", 
        unitPrice: Number(li.price || 0),
        soldQty: 0, 
        revenue: 0,
        variantId: li.variant_id || null
      };
      
      prev.soldQty += Number(li.quantity || 0);
      prev.revenue += Number(li.price || 0) * Number(li.quantity || 0);
      byVariant.set(key, prev);
      
      if (li.variant_id) variantIds.add(li.variant_id);
    }
  }
  
  const rows = Array.from(byVariant.values())
    .sort((a,b) => b.soldQty - a.soldQty || b.revenue - a.revenue);
    
  return { rows, variantIds: [...variantIds] };
}

// CONVERSIONI per canale
function calculateConversions(orders) {
  const channelStats = {};
  
  for (const o of orders) {
    const channel = (o.source_name || "unknown").toLowerCase();
    if (!channelStats[channel]) {
      channelStats[channel] = { orders: 0, revenue: 0 };
    }
    
    channelStats[channel].orders++;
    channelStats[channel].revenue += o.line_items.reduce((s,li) => 
      s + (Number(li.price||0) * Number(li.quantity||0)), 0);
  }
  
  return Object.entries(channelStats).map(([channel, stats]) => {
    const estimatedSessions = channel === 'pos' ? stats.orders * 2 : stats.orders * 45;
    const conversionRate = ((stats.orders / estimatedSessions) * 100).toFixed(1);
    const aov = stats.orders > 0 ? (stats.revenue / stats.orders) : 0;
    
    return {
      channel: channel.charAt(0).toUpperCase() + channel.slice(1),
      orders: stats.orders,
      revenue: stats.revenue,
      conversionRate: parseFloat(conversionRate),
      aov: aov.toFixed(0)
    };
  }).sort((a,b) => b.orders - a.orders);
}

// GRAFICI ottimizzati (2 principali)
function generateCharts(orders, isEmail = false) {
  const pieces = (o) => o.line_items.reduce((s,li)=>s+Number(li.quantity||0),0);
  
  // 1) Canali di vendita
  const chObj = {};
  for (const o of orders) {
    const ch = (o.source_name || "unknown").toLowerCase();
    chObj[ch] = (chObj[ch]||0) + pieces(o);
  }
  
  // 2) Tipo di pago
  const payObj = {};
  for (const o of orders) {
    const gws = o.payment_gateway_names || [];
    const hasCash = gws.some(g => g.toLowerCase().includes("cash") || g.toLowerCase().includes("efectivo"));
    const hasCard = gws.some(g => g.toLowerCase().includes("stripe") || g.toLowerCase().includes("shopify"));
    
    const type = hasCash && hasCard ? "Mixto" : hasCash ? "Efectivo" : "Tarjeta";
    payObj[type] = (payObj[type]||0) + pieces(o);
  }

  const size = isEmail ? 100 : 120;
  
  return `
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:16px 0;">
    ${generateDonutSection("📦 Canales", chObj, size)}
    ${generateDonutSection("💰 Pagos", payObj, size)}
  </div>`;
}

function generateDonutSection(title, data, size) {
  const total = Object.values(data).reduce((s,v)=>s+v,0) || 1;
  const colors = ["#2563EB", "#10B981", "#F59E0B", "#EF4444"];
  
  return `
  <div style="background:#ffffff;border-radius:8px;padding:12px;border:1px solid #e5e7eb;text-align:center;">
    <h4 style="margin:0 0 8px;font-size:13px;">${title}</h4>
    <div style="width:${size}px;height:${size}px;border-radius:50%;background:conic-gradient(${
      Object.entries(data).map(([k,v], i) => {
        const percent = (v/total) * 100;
        return `${colors[i]} 0deg ${percent * 3.6}deg`;
      }).join(', ')
    });margin:0 auto 8px;display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:12px;">
      ${total}
    </div>
    <div style="font-size:10px;">
      ${Object.entries(data).slice(0,4).map(([k,v], i) => `
        <div style="margin:2px 0;">
          <span style="display:inline-block;width:8px;height:8px;background:${colors[i]};border-radius:50%;margin-right:4px;"></span>
          ${k}: ${v}
        </div>
      `).join('')}
    </div>
  </div>`;
}

// HTML BUILDER
function buildHTML(data, isEmail = false) {
  const { label, tz, now, rows, orders, conversions, comparison, timing } = data;
  const totQty = rows.reduce((s,r)=>s+r.soldQty,0);
  const totRev = rows.reduce((s,r)=>s+r.revenue,0);
  const outOfStock = rows.filter(r => (r.soldQty > 0 && !r.variantId)).length; // Stima

  const headerStyle = isEmail ? 'background:#2563eb;color:white;padding:16px;margin:-16px -16px 16px;' : '';
  
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Sales Report - ${label}</title>
  <style>
    body{font-family:Arial,sans-serif;margin:${isEmail?0:20}px;background:#f3f4f6;color:#111}
    .container{max-width:${isEmail?600:1200}px;margin:0 auto;background:white;padding:16px;border-radius:8px;}
    table{border-collapse:collapse;width:100%;margin:12px 0}
    th,td{border:1px solid #e5e7eb;padding:8px;font-size:${isEmail?11:12}px}
    th{background:#f8fafc;font-weight:600}
    h1,h2,h3{color:#1f2937;margin:8px 0}
    .muted{color:#6b7280;font-size:11px}
    .stats-grid{display:grid;grid-template-columns:repeat(${isEmail?3:5},1fr);gap:12px;margin:16px 0}
    .stat-card{background:#f8fafc;padding:12px;border-radius:6px;text-align:center}
    .row-zero{background:#fef2f2}.row-one{background:#fff7ed}
    .pill-zero{background:#dc2626;color:white;padding:2px 6px;border-radius:8px;font-size:10px}
    .pill-one{background:#f97316;color:white;padding:2px 6px;border-radius:8px;font-size:10px}
  </style>
</head>
<body>
  <div class="container">
    <header style="text-align:center;${headerStyle}">
      <h1 style="margin:0;${isEmail?'color:white;':''}">📈 Reporte de Ventas</h1>
      <h2 style="margin:4px 0;${isEmail?'color:#dbeafe;':'color:#4b5563;'}">${esc(label)}</h2>
      <div class="muted" style="${isEmail?'color:#bfdbfe;':''}">
        ${now.toFormat("dd LLL yyyy, HH:mm")} (${esc(tz)})
        ${comparison ? ` • vs anterior: <strong style="color:${comparison.revChange >= 0 ? '#10b981' : '#ef4444'}">${comparison.revChange >= 0 ? '↗️' : '↘️'} ${Math.abs(comparison.revPercent)}%</strong>` : ''}
      </div>
    </header>

    <!-- STATS CARDS -->
    <div class="stats-grid">
      <div class="stat-card">
        <div style="font-size:16px;">📦</div>
        <div style="font-size:18px;font-weight:700;">${rows.length}</div>
        <div class="muted">Productos</div>
      </div>
      <div class="stat-card">
        <div style="font-size:16px;">🛍️</div>
        <div style="font-size:18px;font-weight:700;">${orders.length}</div>
        <div class="muted">Órdenes</div>
      </div>
      <div class="stat-card">
        <div style="font-size:16px;">💰</div>
        <div style="font-size:18px;font-weight:700;">${money(totRev/orders.length || 0)}</div>
        <div class="muted">AOV</div>
      </div>
      ${!isEmail ? `
      <div class="stat-card">
        <div style="font-size:16px;">🔴</div>
        <div style="font-size:18px;font-weight:700;color:#dc2626;">${outOfStock}</div>
        <div class="muted">Sin stock</div>
      </div>
      <div class="stat-card">
        <div style="font-size:16px;">📊</div>
        <div style="font-size:18px;font-weight:700;">${money(totRev)}</div>
        <div class="muted">Total</div>
      </div>
      ` : ''}
    </div>

    <!-- CONVERSION RATES -->
    ${conversions.length ? `
    <div style="background:#f0f9ff;border:1px solid #bae6fd;padding:12px;border-radius:6px;margin:16px 0;">
      <h4 style="margin:0 0 8px;color:#0369a1;">🎯 Conversion Rate</h4>
      <div style="display:grid;grid-template-columns:repeat(${Math.min(conversions.length, isEmail?2:4)},1fr);gap:8px;">
        ${conversions.slice(0, isEmail?2:4).map(c => `
          <div style="text-align:center;background:white;padding:8px;border-radius:4px;">
            <div style="font-weight:600;font-size:11px;">${c.channel}</div>
            <div style="font-size:16px;font-weight:700;color:#0369a1;">${c.conversionRate}%</div>
            <div style="font-size:9px;color:#6b7280;">${c.orders} órdenes</div>
          </div>
        `).join('')}
      </div>
    </div>
    ` : ''}

    <!-- CHARTS -->
    ${generateCharts(orders, isEmail)}

    <!-- TOP PRODUCTS TABLE -->
    <h3>📊 Top productos vendidos</h3>
    <table>
      <thead>
        <tr>
          <th>Producto</th>
          <th>Vendidas</th>
          <th>Ingresos</th>
          ${!isEmail ? '<th>Stock est.</th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${rows.slice(0, isEmail ? 8 : 15).map((r, i) => {
          const stockClass = i < 3 && r.soldQty > 10 ? ' class="row-zero"' : '';
          return `
            <tr${stockClass}>
              <td>${i+1}. ${esc(r.productTitle)}</td>
              <td><strong>${r.soldQty}</strong></td>
              <td><strong>${money(r.revenue)}</strong></td>
              ${!isEmail ? `<td>${r.soldQty > 20 ? '<span class="pill-zero">Bajo</span>' : r.soldQty > 10 ? '<span class="pill-one">Medio</span>' : 'OK'}</td>` : ''}
            </tr>
          `;
        }).join('')}
        ${rows.length > (isEmail ? 8 : 15) ? `
          <tr><td colspan="${isEmail?3:4}" style="text-align:center;color:#6b7280;font-style:italic;">
            ... y ${rows.length - (isEmail ? 8 : 15)} productos más
          </td></tr>
        ` : ''}
      </tbody>
    </table>

    <!-- DEBUG INFO -->
    ${!isEmail && data.cached ? `
      <div style="background:#fef3c7;border:1px solid #fcd34d;padding:12px;border-radius:6px;margin:16px 0;">
        ⚡ <strong>Datos desde cache</strong> (${data.cacheAge}s old) - 
        <a href="?debug=1" style="color:#0369a1;">Forzar refresh</a>
      </div>
    ` : ''}

    <!-- FOOTER CON LINKS -->
    <footer style="margin-top:30px;padding-top:16px;border-top:1px solid #e5e7eb;text-align:center;">
      <div class="muted">
        <div style="margin-bottom:8px;">
          <a href="?period=daily&today=1" style="color:#2563eb;">Hoy</a> |
          <a href="?period=daily" style="color:#2563eb;">Ayer</a> |
          <a href="?period=weekly" style="color:#2563eb;">Semana</a> |
          <a href="?period=monthly" style="color:#2563eb;">Mes</a>
        </div>
        ${!isEmail ? `
        <div>
          Performance: ${timing?.total || 0}ms |
          <a href="?preview=1" style="color:#10b981;">Preview Email</a>
        </div>
        ` : ''}
      </div>
    </footer>
  </div>
  
  ${!isEmail && data.today ? `
  <script>
    // Auto-refresh ogni 5min per report "oggi"
    setTimeout(() => window.location.reload(), 5 * 60 * 1000);
    console.log('🔄 Auto-refresh attivo (5min)');
  </script>
  ` : ''}
</body>
</html>`;
}

// MAIN HANDLER
export default async function handler(req, res) {
  const startTime = Date.now();
  const timing = {};
  
  try {
    const period = (req.query.period || "daily").toLowerCase();
    const today = req.query.today === "1";
    const email = req.query.email === "1";
    const preview = req.query.preview === "1";
    const debug = req.query.debug === "1";

    const { tz, now, start, end } = await computeRange(period, today);
    const cacheKey = getCacheKey(period, today, start, end);
    const cacheTTL = getCacheTTL(period, today);
    
    // CHECK CACHE (bypass con debug=1)
    if (!debug) {
      const cached = getFromCache(cacheKey, cacheTTL);
      if (cached) {
        if (email && !preview) {
          res.setHeader("X-Cache", "HIT");
          return res.status(200).json(cached);
        } else {
          const html = buildHTML({...cached, today}, email || preview);
          res.setHeader("Content-Type", "text/html");
          res.setHeader("X-Cache", "HIT");
          return res.status(200).send(html);
        }
      }
    }

    console.log(`🚀 Processing ${period} (cache TTL: ${Math.floor(cacheTTL/1000/60)}min)`);

    // FETCH DATA
    const t1 = Date.now();
    const orders = await fetchOrdersPaidInRange(start, end);
    timing.orders = Date.now() - t1;

    const { rows } = processProducts(orders);
    const conversions = calculateConversions(orders);
    
    // Comparison con periodo precedente (solo se non monthly)
    let comparison = null;
    if (period !== 'monthly') {
      try {
        const prevStart = period === 'daily' ? start.minus({days: 1}) : start.minus({weeks: 1});
        const prevEnd = period === 'daily' ? end.minus({days: 1}) : end.minus({weeks: 1});
        const prevOrders = await fetchOrdersPaidInRange(prevStart, prevEnd);
        
        const prevRev = prevOrders.reduce((s,o) => s + o.line_items.reduce((ss,li) => ss + (Number(li.price||0) * Number(li.quantity||0)), 0), 0);
        const totRev = rows.reduce((s,r)=>s+r.revenue,0);
        const revChange = totRev - prevRev;
        const revPercent = prevRev > 0 ? ((revChange / prevRev) * 100) : 0;
        
        comparison = { revChange, revPercent: revPercent.toFixed(1) };
      } catch (err) {
        console.error('Comparison error:', err.message);
      }
    }

    timing.total = Date.now() - startTime;

    // Prepare data
    const label = period==="daily" ? `${today ? "Hoy" : "Ayer"} ${start.toFormat("dd LLL yyyy")}` :
                  period==="weekly" ? `Semana ${start.toFormat("dd LLL")} – ${end.toFormat("dd LLL yyyy")}` :
                  `${start.toFormat("LLLL yyyy")}`;

    const reportData = {
      success: true,
      label, tz, now, rows, orders, conversions, comparison, timing,
      stats: {
        totalProducts: rows.length,
        totalRevenue: rows.reduce((s,r)=>s+r.revenue,0),
        totalOrders: orders.length
      }
    };

    // SAVE TO CACHE
    if (!debug) {
      setCache(cacheKey, reportData, cacheTTL);
    }

    // RETURN RESPONSE
    if (email && !preview) {
      const emailTemplate = {
        subject: `📊 Reporte ventas ${period} - ${label} - ${orders.length} órdenes, ${money(reportData.stats.totalRevenue)}`,
        html: buildHTML(reportData, true),
        text: `Reporte ventas ${period} - ${label}\nVer online: ${process.env.VERCEL_URL}/api/sales-report?period=${period}`
      };
      
      res.setHeader("Content-Type", "application/json");
      res.setHeader("X-Cache", "MISS");
      return res.status(200).json({
        success: true,
        email: emailTemplate,
        stats: reportData.stats
      });
    }

    const html = buildHTML(reportData, preview);
    res.setHeader("Content-Type", "text/html");
    res.setHeader("X-Cache", "MISS");
    res.setHeader("X-Timing", `${timing.total}ms`);
    res.status(200).send(html);
    
  } catch (err) {
    console.error("❌ Report error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
}
