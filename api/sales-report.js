// /api/sales-report.js - Versione COMPLETA con tutte le funzionalità ORIGINALI + inventario migliorato
import { DateTime } from "luxon";

// CACHE ottimizzata - ORIGINALE
const reportCache = new Map();
function getCacheTTL(period, today) {
  if (today) return 3 * 60 * 1000;
  if (period === "daily") return 10 * 60 * 1000;
  if (period === "weekly") return 2 * 60 * 60 * 1000; // 2 ore per weekly
  return 4 * 60 * 60 * 1000; // 4 ore per monthly
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
    return null;
  }
  return { ...cached.data, cached: true, cacheAge: Math.floor(age/1000) };
}

function setCache(key, data, ttl) {
  if (reportCache.size >= 15) {
    const oldest = reportCache.keys().next().value;
    reportCache.delete(oldest);
  }
  reportCache.set(key, { data, timestamp: Date.now() });
}

// SHOPIFY API - ORIGINALE
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

// 1. FIX TIMEZONE - forza Monterrey/Mexico
async function getShopTZ() {
  // Forza timezone Monterrey invece di UTC
  return "America/Monterrey";
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

// CHUNK helper
const chunk = (arr, n) => Array.from({length: Math.ceil(arr.length/n)}, (_,i)=>arr.slice(i*n,(i+1)*n));

// FETCH VARIANTS con inventory
async function fetchVariantsByIds(variantIds) {
  const ids = [...new Set(variantIds.filter(Boolean))];
  const out = new Map();
  
 console.log(`Fetching ${ids.length} variants with rate limiting...`);
  
  for (const variantId of ids) {
    try {
      // Usa chiamate individuali come il debug inventory
      const { variant } = await shopFetchJson(REST(`/variants/${variantId}.json`));
      
      if (variant) {
        out.set(String(variant.id), {
          inventory_item_id: variant.inventory_item_id,
          inventory_quantity: variant.inventory_quantity,
          inventory_management: variant.inventory_management || "",
          sku: variant.sku || "",
          price: variant.price || "0",
          compare_at_price: variant.compare_at_price
        });

        // DELAY per rispettare rate limit
      await new Promise(resolve => setTimeout(resolve, 500)); // 0.5 sec = 2 calls/sec max
        
      }
    } catch (err) {
      if (err.message.includes('429')) {
        console.log('Rate limit hit, waiting 2 seconds...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        // Retry the same variant
        try {
          const { variant } = await shopFetchJson(REST(`/variants/${variantId}.json`));
          if (variant) {
            out.set(String(variant.id), {
              inventory_item_id: variant.inventory_item_id,
              inventory_quantity: variant.inventory_quantity,
              inventory_management: variant.inventory_management || "",
              sku: variant.sku || "",
              price: variant.price || "0",
              compare_at_price: variant.compare_at_price
            });
          }
        } catch (retryErr) {
          console.error(`Retry failed for variant ${variantId}:`, retryErr.message);
        }
      } else {
        console.error(`Error fetch variant ${variantId}:`, err.message);
      }
    }
  }
  
  console.log(`Successfully fetched ${out.size} of ${ids.length} variants`);
  return out;
}

// FETCH INVENTORY LEVELS MIGLIORATA - Solo location attive per default
async function fetchInventoryLevelsForItems(itemIds, includeInactive = false) {
  const ids = [...new Set(itemIds.filter(Boolean).map(String))];
  const res = Object.create(null);
  const locationCache = new Map();
  
  for (const c of chunk(ids, 50)) {
    try {
      const { inventory_levels } = await shopFetchJson(REST(`/inventory_levels.json?inventory_item_ids=${encodeURIComponent(c.join(","))}`));
      for (const lvl of inventory_levels || []) {
        const key = String(lvl.inventory_item_id);
        const available = Number(lvl.available || 0);
        
        // VERIFICA SE LOCATION E' ATTIVA (se richiesto)
        if (!includeInactive) {
          let location = locationCache.get(lvl.location_id);
          if (!location) {
            try {
              const locationData = await shopFetchJson(REST(`/locations/${lvl.location_id}.json`));
              location = locationData.location;
              locationCache.set(lvl.location_id, location);
            } catch (err) {
              console.error(`Error fetching location ${lvl.location_id}:`, err.message);
              continue;
            }
          }
          
          // Solo location attive
          if (!location.active) continue;
        }
        
        res[key] = (res[key] || 0) + available;
      }
    } catch (err) {
      console.error(`Error fetch inventory:`, err.message);
    }
  }
  
  return res;
}

// ELABORAZIONE PRODOTTI COMPLETA
async function processProductsComplete(orders, includeAllLocations) {
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
        variantId: li.variant_id || null,
        inventory_item_id: li.inventory_item_id || null,
        inventoryAvailable: null
      };
      
      prev.soldQty += Number(li.quantity || 0);
      prev.revenue += Number(li.price || 0) * Number(li.quantity || 0);
      byVariant.set(key, prev);
      
      if (li.variant_id) variantIds.add(li.variant_id);
    }
  }
  
  const rows = Array.from(byVariant.values()).sort((a,b) => b.soldQty - a.soldQty || b.revenue - a.revenue);
  
  // FETCH VARIANT INFO
  if (variantIds.size > 0) {
    const variantInfo = await fetchVariantsByIds([...variantIds]);
    
    for (const r of rows) {
      const info = r.variantId ? variantInfo.get(String(r.variantId)) : null;
      if (info) {
        if (!r.inventory_item_id) r.inventory_item_id = info.inventory_item_id || null;
        r._variantFallbackQty = info.inventory_quantity;
        r._variantMgmt = info.inventory_management;
        r.compare_at_price = info.compare_at_price;
      }
    }
  }

  // FETCH INVENTORY LEVELS con opzione location
  const itemIds = rows.map(r=>r.inventory_item_id).filter(Boolean);
  if (itemIds.length > 0) {

    // Nella funzione processProductsComplete, prima della chiamata fetchInventoryLevelsForItems
    const debugItemIds = rows.map(r=>r.inventory_item_id).filter(Boolean);
   
    const invLevels = await fetchInventoryLevelsForItems(itemIds, includeAllLocations);
    
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
  }
    
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

// 1. Location breakdown function - AGGIUNGI dopo calculateConversions()
async function getLocationBreakdown(orders) {
  const locationStats = {};
  
  for (const order of orders) {
    let locationName = 'Online';
    
    if (order.location_id) {
      try {
        const { location } = await shopFetchJson(REST(`/locations/${order.location_id}.json`));
        locationName = location.name || `Location ${order.location_id}`;
      } catch (err) {
        locationName = `Location ${order.location_id}`;
      }
    } else if (order.source_name && order.source_name.toLowerCase().includes('pos')) {
      locationName = 'POS (Location Unknown)';
    }

    if (!locationStats[locationName]) {
      locationStats[locationName] = { orders: 0, revenue: 0, items: 0 };
    }

    const revenue = order.line_items.reduce((s,li) => s + (Number(li.price||0) * Number(li.quantity||0)), 0);
    const items = order.line_items.reduce((s,li) => s + Number(li.quantity||0), 0);

    locationStats[locationName].orders++;
    locationStats[locationName].revenue += revenue;
    locationStats[locationName].items += items;
  }

  return locationStats;
}


// DEAD STOCK DETECTION
async function detectDeadStock(variantIds, now, period = 'daily') {
  try {

    // Skip dead stock detection for weekly/monthly to avoid rate limits
    if (period === 'weekly' || period === 'monthly') {
      console.log('Skipping dead stock detection for', period, 'to avoid rate limits');
      return [];
    }
    
    const deadStockDays = parseInt(process.env.DEAD_STOCK_DAYS) || 90;
    const cutoffDate = now.minus({days: deadStockDays});
    
    const orders60 = await fetchOrdersPaidInRange(cutoffDate.startOf("day"), now.endOf("day"));
    
    const soldVariants = new Set();
    for (const o of orders60) {
      for (const li of o.line_items || []) {
        if (li.variant_id) soldVariants.add(String(li.variant_id));
      }
    }
    
    const deadVariantIds = variantIds.filter(id => !soldVariants.has(String(id)));
    if (deadVariantIds.length === 0) return [];
    
    const deadVariantInfo = await fetchVariantsByIds(deadVariantIds);
    const deadItemIds = Array.from(deadVariantInfo.values()).map(v => v.inventory_item_id).filter(Boolean);
    const deadInventory = await fetchInventoryLevelsForItems(deadItemIds); // Solo location attive
    
    return deadVariantIds.map(vid => {
      const info = deadVariantInfo.get(String(vid));
      if (!info) return null;
      
      const itemId = String(info.inventory_item_id);
      const quantity = deadInventory[itemId] || info.inventory_quantity || 0;
      const value = quantity * Number(info.price || 0);
      
      return {
        variantId: vid,
        sku: info.sku || "",
        quantity,
        unitPrice: Number(info.price || 0),
        totalValue: value,
        daysStagnant: deadStockDays
      };
    }).filter(Boolean).filter(item => item.quantity > 0).sort((a,b) => b.totalValue - a.totalValue);
    
  } catch (err) {
    console.error('Error detecting dead stock:', err.message);
    return [];
  }
}

// ROP CALCULATION
function computeROP({sales30d, onHand, leadDays, safetyDays}) {
  const realLeadDays = leadDays || parseInt(process.env.ROP_LEAD_DAYS) || 7;
  const realSafetyDays = safetyDays || parseInt(process.env.ROP_SAFETY_DAYS) || 3;
  const dailyVel = Math.max(0, sales30d/30);
  /*const rop = Math.ceil(dailyVel * (leadDays + safetyDays));
  const target = Math.ceil(dailyVel * (leadDays + safetyDays + 14));*/
  const rop = Math.ceil(dailyVel * (realLeadDays + realSafetyDays));
  const target = Math.ceil(dailyVel * (realLeadDays + realSafetyDays + 14));
  const coverage = dailyVel > 0 ? (onHand / dailyVel) : Infinity;
  const qty = Math.max(0, target - onHand);
  
  let urgency = 'medium';
  /*if (coverage <= leadDays) urgency = 'critical';
  else if (coverage <= (leadDays + safetyDays)) urgency = 'high';*/
  if (coverage <= realLeadDays) urgency = 'critical';
    else if (coverage <= (realLeadDays + realSafetyDays)) urgency = 'high';
  
  return { 
    dailyVel: dailyVel.toFixed(2), 
    rop, target, qty, 
    coverage: Number.isFinite(coverage) ? coverage.toFixed(1) : 'inf',
    urgency 
  };
}

// ABC ANALYSIS
function computeABCAnalysis(rows) {
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  let cumulativeRevenue = 0;
  
  return rows.map((r, index) => {
    cumulativeRevenue += r.revenue;
    const cumulativePercent = (cumulativeRevenue / totalRevenue) * 100;
    
    let category = 'C';
    if (cumulativePercent <= 80) category = 'A';
    else if (cumulativePercent <= 95) category = 'B';
    
    return {
      ...r,
      rank: index + 1,
      revenuePercent: ((r.revenue / totalRevenue) * 100).toFixed(1),
      cumulativePercent: cumulativePercent.toFixed(1),
      abcCategory: category
    };
  });
}

// 4 GRAFICI COMPLETI
const PALETTE = ["#2563EB", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#06B6D4"];

// 3. FIX GRAFICI - gestisce dati singoli
function donutSVG(parts, size=140) {
  if (!parts.length || parts.every(p => p.value === 0)) {
    return `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:50%;color:#9ca3af;font-size:12px;">Sin datos</div>`;
  }

  // Se c'e' UN SOLO dato, fai cerchio completo
  if (parts.length === 1) {
    return `
    <div style="width:${size}px;height:${size}px;border-radius:50%;background:${PALETTE[0]};display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:14px;margin:0 auto;">
      ${parts[0].value.toLocaleString("es-MX")}
    </div>`;
  }

  const total = parts.reduce((s,p)=>s+p.value,0) || 1;
  const r = size/2 - 10, cx=size/2, cy=size/2, w=20;
  let a0 = -Math.PI/2, segs="";
  
  parts.forEach((p, i)=>{
    const a1 = a0 + (p.value/total)*Math.PI*2;
    const x0 = cx + r*Math.cos(a0), y0 = cy + r*Math.sin(a0);
    const x1 = cx + r*Math.cos(a1), y1 = cy + r*Math.sin(a1);
    const large = (a1-a0) > Math.PI ? 1 : 0;
    const path = `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} L ${cx + (r-w)*Math.cos(a1)} ${cy + (r-w)*Math.sin(a1)} A ${r-w} ${r-w} 0 ${large} 0 ${cx + (r-w)*Math.cos(a0)} ${cy + (r-w)*Math.sin(a0)} Z`;
    segs += `<path d="${path}" fill="${PALETTE[i%PALETTE.length]}" stroke="#fff" stroke-width="1" />`;
    a0 = a1;
  });
  
  const totalLabel = total.toLocaleString("es-MX");
  segs += `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" fill="#374151" font-weight="600" font-size="14">${totalLabel}</text>`;
  
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${segs}</svg>`;
}
// Función para generar URLs de gráficos estáticos con QuickChart
/*function generateChartUrl(chartConfig, width = 140, height = 140) {
  const config = {
    ...chartConfig,
    options: {
      ...chartConfig.options,
      plugins: {
        legend: { display: false }, // Sin leyenda para que sea más compacto
        datalabels: { display: false }
      }
    }
  };
  
  const encodedConfig = encodeURIComponent(JSON.stringify(config));
  return `https://quickchart.io/chart?c=${encodedConfig}&w=${width}&h=${height}&f=png&bkg=white`;
}

function donutSVG(parts, size = 140) {
  if (!parts.length || parts.every(p => p.value === 0)) {
    return `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:8px;color:#9ca3af;font-size:12px;">Sin datos</div>`;
  }

  // Configuración Chart.js para QuickChart
  const chartConfig = {
    type: 'doughnut',
    data: {
      labels: parts.map(p => p.label),
      datasets: [{
        data: parts.map(p => p.value),
        backgroundColor: parts.map((_, i) => PALETTE[i % PALETTE.length]),
        borderColor: '#ffffff',
        borderWidth: 2
      }]
    },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      cutout: '60%', // Para hacer el donut
      plugins: {
        legend: { display: false },
        datalabels: { display: false }
      }
    }
  };

  const chartUrl = generateChartUrl(chartConfig, size, size);
  
  return `<img src="${chartUrl}" alt="Chart" style="width:${size}px;height:${size}px;border-radius:8px;" onerror="this.style.display='none';" />`;
}*/

// 4. FIX HORARIOS - usa timezone corretto
// Sostituisci TUTTA la funzione chartsHTML (dalle linee 497 alle 709) con questa versione corretta:

function chartsHTML(orders, isEmail = false, locationStatsParam = null) {
  console.log(`=== CHARTHTML: Processing ${orders.length} orders ===`);
  
  const locStats = locationStatsParam || {};
  const pieces = (o) => o.line_items.reduce((s,li)=>s+Number(li.quantity||0),0);
  const revenue = (o) => o.line_items.reduce((s,li)=>s+(Number(li.price||0)*Number(li.quantity||0)),0);

  // 1) Canali di vendita CON DETTAGLI LOCATION
  const chObj = {};
  if (Object.keys(locStats).length) {
    for (const [locationName, stats] of Object.entries(locStats)) {
      if (locationName === 'Online') {
        chObj['Online'] = stats.items;
      } else {
        chObj[locationName] = stats.items;
      }
    }
  } else {
    // fallback: calcolo per canale direttamente dagli ordini
    for (const o of orders) {
      const ch = (o.source_name || "unknown").toLowerCase();
      chObj[ch] = (chObj[ch]||0) + pieces(o);
    }
  }

  // 2) Tipo di pago - CON LOGGING E FIX USO INTERNO
  const grpObj = {};
  for (const o of orders) {
    const gws = o.payment_gateway_names || [];
    const orderDate = DateTime.fromISO(o.created_at).setZone("America/Monterrey");
    
    // Log per tutti gli ordini
    console.log(`Ordine ${o.id} del ${orderDate.toFormat('dd/MM')}: total="${o.total_price}" (${typeof o.total_price}), gws=[${gws.join(',')}], customer=${o.customer?.first_name || 'N/A'}`);
    
    // PRIMO CONTROLLO: Uso Interno (gateway vuoto E totale 0)
    if (gws.length === 0 && (Number(o.total_price) === 0)) {
      console.log(`>>> USO INTERNO TROVATO: ordine ${o.id}, total=${o.total_price}`);
      grpObj["Uso Interno"] = (grpObj["Uso Interno"] || 0) + pieces(o);
      continue; // Salta il resto della logica per questo ordine
    }
    
    // Log per gateway vuoti che NON sono uso interno
    if (gws.length === 0) {
      console.log(`>>> GATEWAY VUOTO ma NON uso interno: ordine ${o.id}, total=${o.total_price}, isZero=${Number(o.total_price) === 0}`);
    }
    
    // Analizza i gateway per determinare il tipo di pagamento
    const hasCash = gws.some(g => g.toLowerCase().includes("cash") || g.toLowerCase().includes("efectivo"));
    const hasPayPal = gws.some(g => g.toLowerCase().includes("paypal"));
    const hasFiserv = gws.some(g => g.toLowerCase().includes("fiserv"));
    const hasShopifyPayments = gws.some(g => g.toLowerCase().includes("shopify_payments"));
    const hasMercadoPago = gws.some(g => g.toLowerCase().includes("mercado"));
    
    let paymentType;
    
    // Logica di classificazione migliorata
    if (hasCash && hasFiserv) {
      paymentType = "Mixto (Cash + Fiserv Pos)";
    } else if (hasCash && hasPayPal) {
      paymentType = "Mixto (Cash + PayPal)";
    } else if (hasCash && hasShopifyPayments) {
      paymentType = "Mixto (Cash + Tarjeta)";
    } else if (hasCash) {
      paymentType = "Efectivo";
    } else if (hasPayPal) {
      paymentType = "PayPal";
    } else if (hasFiserv) {
      paymentType = "Fiserv Pos";
    } else if (hasShopifyPayments) {
      paymentType = "Tarjeta (Shopify)";
    } else if (hasMercadoPago) {
      paymentType = "Mercado Pago";
    } else {
      console.log(`>>> QUESTO DIVENTA OTRO: ordine ${o.id}, gws=[${gws.join(',')}], total=${o.total_price}`);
      paymentType = `Otro (${gws.join(', ')})`;
    }
    
    grpObj[paymentType] = (grpObj[paymentType]||0) + pieces(o);
  }

  // 3) Franjas horarias - FIX TIMEZONE
  const hourObj = {};
  for (const o of orders) {
    const orderDate = DateTime.fromISO(o.created_at).setZone("America/Monterrey");
    const hour = orderDate.hour;
    
    const timeSlot = 
      hour < 6 ? "Madrugada (00-06)" :
      hour < 12 ? "Manana (06-12)" :
      hour < 18 ? "Tarde (12-18)" :
      "Noche (18-24)";
    hourObj[timeSlot] = (hourObj[timeSlot]||0) + pieces(o);
  }

  // 4) Rangos de ticket
  const ticketObj = {};
  for (const o of orders) {
    const total = revenue(o);
    const range = 
      total < 500 ? "Bajo (<$500)" :
      total < 1500 ? "Medio ($500-1500)" :
      total < 3000 ? "Alto ($1500-3000)" :
      "Premium (>$3000)";
    ticketObj[range] = (ticketObj[range]||0) + 1;
  }

  console.log('=== RISULTATI PAGAMENTI ===', grpObj);

  const top = (obj) => Object.entries(obj).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>({label:k,value:v}));

  const sections = [
    { title:"Canales de venta", parts: top(chObj) },
    { title:"Tipo de pago", parts: top(grpObj) },
    { title:"Horarios de venta", parts: Object.entries(hourObj).map(([k,v])=>({label:k,value:v})) },
    { title:"Rangos de ticket", parts: Object.entries(ticketObj).map(([k,v])=>({label:k,value:v})) },
  ];

  // Rendering HTML
  if (isEmail) {
    const chartSize = 100;
    return `
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin:20px 0;" class="charts-container">
      ${sections.map(sec => `
        <div style="background:#ffffff;border-radius:8px;padding:16px;border:1px solid #e5e7eb;">
          <h4 style="margin:0 0 12px;color:#374151;font-size:13px;font-weight:600;">${sec.title}</h4>
          <div style="text-align:center;">
            ${donutSVG(sec.parts, chartSize)}
          </div>
          <div style="margin-top:12px;font-size:10px;">
            ${sec.parts.slice(0, 4).map((p,i)=>`
              <div style="display:flex;align-items:center;margin:2px 0;">
                <span style="display:inline-block;width:12px;height:12px;background:${PALETTE[i%PALETTE.length]};margin-right:8px;border-radius:3px;"></span>
                <span style="flex:1;">${esc(p.label)}</span>
                <span style="font-weight:600;">${p.value}</span>
              </div>
            `).join("")}
          </div>
        </div>
      `).join("")}
    </div>`;
  }
  
  const chartSize = 140;
  const gridCols = "repeat(auto-fit, minmax(280px, 1fr))";

  return `
  <div style="display:grid;grid-template-columns:${gridCols};gap:24px;margin:20px 0;" class="charts-container">
    ${sections.map(sec => `
      <div style="background:#fafafa;border-radius:8px;padding:16px;border:1px solid #e5e7eb;">
        <h4 style="margin:0 0 12px;color:#374151;font-size:14px;font-weight:600;">${sec.title}</h4>
        <div style="text-align:center;">
          ${donutSVG(sec.parts, chartSize)}
        </div>
        <div style="margin-top:12px;font-size:11px;">
          ${sec.parts.slice(0, 8).map((p,i)=>`
            <div style="display:flex;align-items:center;margin:4px 0;">
              <span style="display:inline-block;width:12px;height:12px;background:${PALETTE[i%PALETTE.length]};margin-right:8px;border-radius:3px;"></span>
              <span style="flex:1;">${esc(p.label)}</span>
              <span style="font-weight:600;">${p.value}</span>
            </div>
          `).join("")}
        </div>
      </div>
    `).join("")}
  </div>`;
}

// La prossima funzione dovrebbe essere renderLocationBreakdown che inizia alla linea ~710

  // 3. Location breakdown rendering - AGGIUNGI
function renderLocationBreakdown(locationStats, isEmail = false) {
  const locations = Object.entries(locationStats).sort((a,b) => b[1].revenue - a[1].revenue);
  
  if (!locations.length) return '';
  
  return `
  <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:20px 0;">
    <h4 style="margin:0 0 12px;color:#374151;">Breakdown por Location</h4>
    <div style="display:grid;grid-template-columns:repeat(${Math.min(locations.length, 3)},1fr);gap:12px;">
      ${locations.map(([name, stats]) => `
        <div style="text-align:center;background:white;padding:12px;border-radius:6px;border:1px solid #e5e7eb;">
          <div style="font-weight:600;color:#374151;font-size:${isEmail ? 11 : 12}px;margin-bottom:4px;">${esc(name)}</div>
          <div style="font-size:${isEmail ? 14 : 16}px;font-weight:700;color:#2563eb;">${money(stats.revenue)}</div>
          <div style="font-size:${isEmail ? 9 : 10}px;color:#6b7280;">${stats.orders} órdenes</div>
          <div style="font-size:${isEmail ? 9 : 10}px;color:#6b7280;">${stats.items} items</div>
        </div>
      `).join('')}
    </div>
  </div>`;
}

// 5. Email semplificata - AGGIUNGI
function buildEmailHTML(data) {
  const { label, tz, now, rows, orders, timing, locationStats } = data;
  const totRev = rows.reduce((s,r)=>s+r.revenue,0);
  const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';
  
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Reporte de Ventas - ${label}</title>
  ${styles(true)}
</head>
<body>
  <div class="container">
    <header style="text-align:center;background:#2563eb;color:white;padding:20px;margin:-16px -16px 24px;">
      <h1 style="margin:0;color:white;">Reporte de Ventas</h1>
      <h2 style="margin:8px 0;color:#dbeafe;">${esc(label)}</h2>
      <div style="color:#bfdbfe;font-size:12px;">
        Generado: ${now.toFormat("dd LLL yyyy, HH:mm")} (${esc(tz)})
      </div>
    </header>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-number">${rows.length}</div>
        <div class="stat-label">Productos</div>
      </div>
      <div class="stat-card">
        <div class="stat-number">${orders.length}</div>
        <div class="stat-label">Órdenes</div>
      </div>
      <div class="stat-card">
        <div class="stat-number">${money(totRev)}</div>
        <div class="stat-label">Ingresos</div>
      </div>
      <div class="stat-card">
        <div class="stat-number">${money(totRev/orders.length || 0)}</div>
        <div class="stat-label">Ticket Prom.</div>
      </div>
      <div class="stat-card">
        <div class="stat-number" style="color:#dc2626;">${rows.filter(r=>Number(r.inventoryAvailable||0)<=1).length}</div>
        <div class="stat-label">Stock Crítico</div>
      </div>
    </div>

    ${renderLocationBreakdown(locationStats, true)}
    ${chartsHTML(orders, true, locationStats)}

    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;margin:20px 0;text-align:center;">
      <div style="font-weight:600;margin-bottom:8px;">📊 Reporte Completo</div>
      <div style="margin-bottom:12px;">
        <a href="${baseUrl}/api/sales-report?period=daily" style="color:#2563eb;text-decoration:none;font-weight:500;">Ver Análisis Completo Online</a>
      </div>
      <div style="font-size:11px;color:#6b7280;">
        PDF archivado automáticamente • Performance: ${timing?.total || 0}ms
      </div>
    </div>

    <footer style="margin-top:30px;padding-top:16px;border-top:1px solid #e5e7eb;">
      <div style="font-size:11px;color:#6b7280;text-align:center;">
        <div style="margin-bottom:8px;"><strong>Trigger Manual:</strong></div>
        <div>
          <a href="${baseUrl}/api/cron/smart-report?trigger=daily" style="color:#059669;text-decoration:none;">Diario</a> |
          <a href="${baseUrl}/api/cron/smart-report?trigger=weekly" style="color:#2563eb;text-decoration:none;">Semanal</a> |
          <a href="${baseUrl}/api/cron/smart-report?trigger=monthly" style="color:#8b5cf6;text-decoration:none;">Mensual</a>
        </div>
      </div>
    </footer>
  </div>
</body>
</html>`;
}



// RENDER FUNCTIONS
function renderConversionAnalysis(conversionData, isEmail = false) {
  if (!conversionData.length) return '';
  
  return `
  <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:16px;margin:20px 0;">
    <h4 style="margin:0 0 12px;color:#0369a1;">Conversion Rate por Canal</h4>
    <div style="display:grid;grid-template-columns:repeat(${isEmail ? 2 : 3},1fr);gap:12px;">
      ${conversionData.slice(0, isEmail ? 4 : 6).map(data => `
        <div style="text-align:center;background:white;padding:12px;border-radius:6px;">
          <div style="font-weight:600;color:#374151;font-size:${isEmail ? 11 : 12}px;">${data.channel}</div>
          <div style="font-size:${isEmail ? 16 : 20}px;font-weight:700;color:#0369a1;margin:4px 0;">${data.conversionRate}%</div>
          <div style="font-size:${isEmail ? 9 : 10}px;color:#6b7280;">${data.orders} ordenes</div>
          <div style="font-size:${isEmail ? 9 : 10}px;color:#6b7280;">AOV: $${data.aov}</div>
        </div>
      `).join('')}
    </div>
  </div>`;
}

function renderDeadStockAlert(deadStockData, isEmail = false) {
  if (!deadStockData.length) {
    return `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin:20px 0;text-align:center;"><strong style="color:#166534;">Excelente!</strong> No hay productos estancados (sin ventas 60+ dias)</div>`;
  }
  
  const totalValue = deadStockData.reduce((s, item) => s + item.totalValue, 0);
  const maxItems = isEmail ? 5 : 10;
  
  return `
  <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin:20px 0;">
    <h4 style="margin:0 0 12px;color:#dc2626;">Dead Stock Alert (60+ dias sin ventas)</h4>
    <div style="background:white;border-radius:6px;padding:12px;margin:12px 0;text-align:center;">
      <div style="font-size:${isEmail ? 18 : 24}px;font-weight:700;color:#dc2626;">${deadStockData.length}</div>
      <div style="font-size:${isEmail ? 10 : 12}px;color:#6b7280;">PRODUCTOS ESTANCADOS</div>
      <div style="font-size:${isEmail ? 11 : 13}px;margin-top:4px;"><strong>Valor total:</strong> ${money(totalValue)}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:${isEmail ? 10 : 11}px;">
      <thead><tr style="background:#f8fafc;"><th style="padding:6px;border:1px solid #e5e7eb;">SKU</th><th style="padding:6px;border:1px solid #e5e7eb;">Stock</th><th style="padding:6px;border:1px solid #e5e7eb;">Valor</th></tr></thead>
      <tbody>
        ${deadStockData.slice(0, maxItems).map(item => `<tr><td style="padding:6px;border:1px solid #e5e7eb;">${item.sku || `ID:${item.variantId}`}</td><td style="padding:6px;border:1px solid #e5e7eb;">${item.quantity}</td><td style="padding:6px;border:1px solid #e5e7eb;font-weight:600;">${money(item.totalValue)}</td></tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

// 6. FIX ABC ANALYSIS - mostra prodotti top

function renderABCSummary(abcData) {
  const categories = {
    A: abcData.filter(r => r.abcCategory === 'A'),
    B: abcData.filter(r => r.abcCategory === 'B'), 
    C: abcData.filter(r => r.abcCategory === 'C')
  };
  
  const totalRevenue = abcData.reduce((s, r) => s + r.revenue, 0);
  
  return `
  <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:16px;margin:20px 0;">
    <h4 style="margin:0 0 12px;color:#0369a1;">📊 Análisis ABC (Regla 80/20)</h4>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:16px;">
      <div style="text-align:center;background:white;padding:12px;border-radius:6px;">
        <div style="font-size:20px;font-weight:700;color:#dc2626;">A</div>
        <div style="font-size:12px;color:#6b7280;">TOP PERFORMERS</div>
        <div><strong>${categories.A.length}</strong> productos</div>
        <div><strong>${((categories.A.reduce((s,r)=>s+r.revenue,0)/totalRevenue)*100).toFixed(0)}%</strong> ingresos</div>
      </div>
      <div style="text-align:center;background:white;padding:12px;border-radius:6px;">
        <div style="font-size:20px;font-weight:700;color:#f97316;">B</div>
        <div style="font-size:12px;color:#6b7280;">MEDIANOS</div>
        <div><strong>${categories.B.length}</strong> productos</div>
        <div><strong>${((categories.B.reduce((s,r)=>s+r.revenue,0)/totalRevenue)*100).toFixed(0)}%</strong> ingresos</div>
      </div>
      <div style="text-align:center;background:white;padding:12px;border-radius:6px;">
        <div style="font-size:20px;font-weight:700;color:#6b7280;">C</div>
        <div style="font-size:12px;color:#6b7280;">COLA LARGA</div>
        <div><strong>${categories.C.length}</strong> productos</div>
        <div><strong>${((categories.C.reduce((s,r)=>s+r.revenue,0)/totalRevenue)*100).toFixed(0)}%</strong> ingresos</div>
      </div>
    </div>
    
    <div style="background:white;border-radius:6px;padding:12px;">
      <strong style="color:#dc2626;">🏆 TOP PERFORMERS (Categoria A):</strong>
      <div style="margin-top:8px;font-size:11px;line-height:1.4;">
        ${categories.A.slice(0,8).map((p, i) => `
          <div style="margin:2px 0;"><strong>${i+1}.</strong> ${esc(p.productTitle)} - ${money(p.revenue)} (${p.revenuePercent}%)</div>
        `).join('')}
        ${categories.A.length > 8 ? `<div style="color:#6b7280;margin-top:4px;">... y ${categories.A.length - 8} productos más</div>` : ''}
      </div>
    </div>
  </div>`;
}

function renderProductsTable(rows, isEmail = false) {
  const maxRows = isEmail ? 15 : 50;
  const displayRows = rows.slice(0, maxRows);
  
  const head = `
  <thead><tr>
    <th align="left">Producto</th>
    <th align="left">Variante</th>
    ${!isEmail ? '<th align="left">SKU</th>' : ''}
    <th align="right">Precio</th>
    <th align="right">Vendidas</th>
    <th align="right">Ingresos</th>
    <th align="right">Stock</th>
  </tr></thead>`;
  
  const body = displayRows.map((r, idx)=>{
    const inv = Number(r.inventoryAvailable ?? 0);
    const rank = idx + 1;
    let cls = "";
    
    let invCell = String(inv);
    if (inv === 0) {
      cls = ' class="row-zero"';
      invCell = `<span style="color:#dc2626;font-weight:bold;">${inv}</span>`;
    } else if (inv === 1) {
      cls = ' class="row-one"';
      invCell = `<span style="color:#f97316;font-weight:bold;">${inv}</span>`;
    } else {
      invCell = `<span style="font-weight:600;">${inv}</span>`;
    }

    return `
      <tr${cls}>
        <td><span class="muted">${rank}.</span> ${esc(r.productTitle)}</td>
        <td>${esc(r.variantTitle)}</td>
        ${!isEmail ? `<td>${esc(r.sku||"")}</td>` : ''}
        <td align="right">${r.unitPrice!=null?esc(money(r.unitPrice)):""}</td>
        <td align="right"><strong>${r.soldQty}</strong></td>
        <td align="right"><strong>${esc(money(r.revenue))}</strong></td>
        <td align="right">${invCell}</td>
      </tr>`;
  }).join("");
  
  const moreText = rows.length > maxRows ? `<div style="color:#6b7280;margin-top:8px;">... y ${rows.length - maxRows} productos mas</div>` : '';
  
  return `<h3>Top productos vendidos</h3><table>${head}<tbody>${body}</tbody></table>${moreText}`;
}

function renderROPTable(rows, isEmail = false) {
  if (!rows.length) {
    return `<div style="margin:16px 0;padding:16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;text-align:center;"><strong style="color:#166534;">Excelente!</strong> Todos los productos tienen stock suficiente.</div>`;
  }
  
  const sortedRows = [...rows].sort((a,b) => {
    const urgencyOrder = {critical: 0, high: 1, medium: 2};
    const aOrder = urgencyOrder[a.urgency] ?? 3;
    const bOrder = urgencyOrder[b.urgency] ?? 3;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return b.sales30d - a.sales30d;
  });
  
  const maxRows = isEmail ? 10 : 25;
  const displayRows = sortedRows.slice(0, maxRows);
  
  const head = `
  <thead><tr>
    <th align="left">Urgencia</th>
    <th align="left">Producto</th>
    <th align="left">Variante</th>
    ${!isEmail ? '<th align="left">SKU</th>' : ''}
    <th align="right">Stock</th>
    <th align="right">Vel/dia</th>
    <th align="right">Dias restantes</th>
    <th align="right">Cantidad</th>
  </tr></thead>`;
  
  const body = displayRows.map(r=>{
    const urgencyPill = r.urgency === 'critical' ? '<span class="pill-critical">CRITICO</span>' :
                        r.urgency === 'high' ? '<span class="pill-high">ALTO</span>' :
                        '<span class="pill-medium">MEDIO</span>';
    
    const rowClass = r.urgency === 'critical' ? ' class="row-critical"' : '';
    
    return `
      <tr${rowClass}>
        <td>${urgencyPill}</td>
        <td>${esc(r.productTitle)}</td>
        <td>${esc(r.variantTitle)}</td>
        ${!isEmail ? `<td>${esc(r.sku||"")}</td>` : ''}
        <td align="right">${r.onHand ?? ""}</td>
        <td align="right">${r.dailyVel}</td>
        <td align="right">${r.coverage}d</td>
        <td align="right"><strong style="color:#dc2626;">${r.qty}</strong></td>
      </tr>`;
  }).join("");
  
  const moreText = rows.length > maxRows ? `<div style="color:#6b7280;margin-top:8px;">... y ${rows.length - maxRows} productos mas para reordenar</div>` : '';
  
  return `<h3>Productos para reordenar</h3>
    <div style="color:#6b7280;margin-bottom:12px;">Ventana: 30d - Lead time: 7d - Safety: 3d</div>
    <table>${head}<tbody>${body}</tbody></table>${moreText}`;
}

function styles(isEmail = false) {
  return `
  <style>
    body{font-family:Inter,Arial,sans-serif;color:#111;margin:${isEmail?0:20}px;background:#fafafa}
    .container{max-width:${isEmail?600:1400}px;margin:0 auto;background:white;padding:${isEmail?16:24}px;border-radius:${isEmail?0:12}px;${isEmail?'':'box-shadow:0 4px 6px -1px rgba(0,0,0,0.1)'}}
    table{border-collapse:collapse;width:100%;margin:16px 0;border-radius:8px;overflow:hidden;${isEmail?'':'box-shadow:0 1px 3px rgba(0,0,0,0.1)'}}
    th,td{border:1px solid #e5e7eb;padding:${isEmail?8:10}px ${isEmail?10:12}px;font-size:${isEmail?12:13}px;vertical-align:top}
    th{background:#f8fafc;font-weight:600;color:#374151}
    h1{margin:0;color:#1f2937;font-size:${isEmail?20:24}px}
    h2{margin:8px 0;color:#4b5563;font-size:${isEmail?16:20}px}
    h3{margin:24px 0 12px;color:#374151;font-size:${isEmail?16:18}px;font-weight:600}
    h4{margin:0 0 8px;color:#374151;font-size:${isEmail?13:14}px;font-weight:600}
    .muted{color:#6B7280;font-size:${isEmail?11:12}px}
    .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(${isEmail?120:200}px,1fr));gap:${isEmail?12:16}px;margin:20px 0}
    .stat-card{background:#f8fafc;padding:${isEmail?12:16}px;border-radius:8px;border:1px solid #e5e7eb;text-align:center}
    .stat-number{font-size:${isEmail?18:24}px;font-weight:700;color:#1f2937;margin:4px 0}
    .stat-label{color:#6b7280;font-size:${isEmail?10:12}px;text-transform:uppercase;letter-spacing:0.5px}
    
    .row-zero{background-color:#fef2f2 !important} 
    .row-zero td{border-color:#fecaca !important}
    .row-one{background-color:#fff7ed !important}  
    .row-one td{border-color:#fed7aa !important}
    .row-critical{background-color:#fdf2f8 !important}
    .row-critical td{border-color:#f9a8d4 !important}
    
    .pill-critical{background:#ec4899;color:white;padding:4px 8px;border-radius:12px;font-weight:600;font-size:11px}
    .pill-high{background:#eab308;color:white;padding:4px 8px;border-radius:12px;font-weight:600;font-size:11px}
    .pill-medium{background:#059669;color:white;padding:4px 8px;border-radius:12px;font-weight:600;font-size:11px}
    
    ${isEmail ? '' : `
    @media (max-width: 768px) {
      body{margin:10px}.container{padding:16px}
      table{font-size:11px}th,td{padding:6px 8px}
      .stats-grid{grid-template-columns:repeat(2,1fr);gap:12px}
    }
    `}
  </style>`;
}

// MAIN HANDLER con opzione per inventory globale
export default async function handler(req, res) {
  const startTime = Date.now();
  const timing = {};
  
  try {
    const period = (req.query.period || "daily").toLowerCase();
    const today = req.query.today === "1";
    const email = req.query.email === "1";
    const preview = req.query.preview === "1";
    const debug = req.query.debug === "1";
    
    const includeAllLocations = req.query.include_all_locations === "1";

    const { tz, now, start, end } = await computeRange(period, today);
    const cacheKey = getCacheKey(period, today, start, end) + (includeAllLocations ? '-all' : '');
    const cacheTTL = getCacheTTL(period, today);
    
    if (!debug) {
      const cached = getFromCache(cacheKey, cacheTTL);
      if (cached) {
        if (email && !preview) {
          res.setHeader("X-Cache", "HIT");
          return res.status(200).json(cached);
        } else {
          const html = buildCompleteHTML({...cached, includeAllLocations: includeAllLocations}, email || preview);
          res.setHeader("Content-Type", "text/html");
          res.setHeader("X-Cache", "HIT");
          return res.status(200).send(html);
        }
      }
    }

    console.log(`Processing ${period} - TTL: ${Math.floor(cacheTTL/1000/60)}min${includeAllLocations ? ' - INCLUDING ALL LOCATIONS' : ''}`);

    const t1 = Date.now();
    const orders = await fetchOrdersPaidInRange(start, end);
    timing.orders = Date.now() - t1;

    const { rows, variantIds } = await processProductsComplete(orders, includeAllLocations);
    const conversions = calculateConversions(orders);
    const locationStats = await getLocationBreakdown(orders);
    
    const deadStockData = await detectDeadStock(variantIds, now, period);
    
    const start30 = now.minus({days:30}).startOf("day");
    const orders30 = await fetchOrdersPaidInRange(start30, now.endOf("day"));
    
    const sales30 = new Map();
    for (const o of orders30) {
      for (const li of o.line_items||[]) {
        const k = li.variant_id || `SKU:${li.sku||li.title}`;
        sales30.set(k, (sales30.get(k)||0) + Number(li.quantity||0));
      }
    }
    
    const ropRows = rows.map(r=>{
      const sales30d = sales30.get(r.variantId ?? `SKU:${r.sku||r.productTitle}`) || 0;
      const rop = computeROP({ 
        sales30d, 
        onHand: Number(r.inventoryAvailable||0), 
        leadDays: 7, 
        safetyDays: 3
      });
      
      return { 
        ...r, 
        onHand: Number(r.inventoryAvailable||0), 
        sales30d,
        dailyVel: rop.dailyVel,
        rop: rop.rop, 
        target: rop.target, 
        qty: rop.qty, 
        coverage: rop.coverage,
        urgency: rop.urgency
      };
    })
    .filter(r => r.qty > 0 || r.onHand <= 1)
    .sort((a,b) => {
      const urgencyOrder = {critical: 0, high: 1, medium: 2};
      return (urgencyOrder[a.urgency] || 3) - (urgencyOrder[b.urgency] || 3) || b.sales30d - a.sales30d;
    });

    const abcData = computeABCAnalysis(rows);
    
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

    const label = period==="daily" ? `${today ? "Hoy" : "Ayer"} ${start.toFormat("dd LLL yyyy")}` :
                  period==="weekly" ? `Semana ${start.toFormat("dd LLL")} - ${end.toFormat("dd LLL yyyy")}` :
                  `${start.toFormat("LLLL yyyy")}`;

    const reportData = {
      success: true,
      label, tz, now, rows, orders, conversions, comparison, timing, deadStockData, ropRows, abcData, locationStats, // <-- aggiungi locationStats
      includeAllLocations: includeAllLocations,
      stats: {
        totalProducts: rows.length,
        totalRevenue: rows.reduce((s,r)=>s+r.revenue,0),
        totalOrders: orders.length
      }
    };

    if (!debug) {
      setCache(cacheKey, reportData, cacheTTL);
    }

    if (email && !preview) {
      const emailTemplate = {
        subject: `Reporte ventas ${period} - ${label} - ${orders.length} ordenes, ${money(reportData.stats.totalRevenue)}`,
        html: buildEmailHTML(reportData, true),
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

    const html = buildCompleteHTML(reportData, preview);
    res.setHeader("Content-Type", "text/html");
    res.setHeader("X-Cache", "MISS");
    res.setHeader("X-Timing", `${timing.total}ms`);
    res.status(200).send(html);
    
  } catch (err) {
    console.error("Report error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
}

function buildCompleteHTML(data, isEmail = false) {
  const { label, tz, now, rows, orders, conversions, comparison, timing, deadStockData, ropRows, abcData, includeAllLocations, locationStats } = data;
  const totRev = rows.reduce((s,r)=>s+r.revenue,0);

  const isEmailMode = isEmail;
  const headerStyle = isEmailMode ? 'background:#2563eb;color:white;padding:20px;margin:-16px -16px 24px;' : '';
  
const inventoryNote = data.includeAllLocations ? ' (Inventario GLOBAL - todas las locations)' : ' (Solo locations activas)';

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Reporte de Ventas - ${label}</title>
  ${styles(isEmailMode)}
</head>
<body>
  <div class="container">
    <header style="text-align:center;${headerStyle}">
      <h1 style="margin:0;${isEmailMode?'color:white;':''}">Reporte de Ventas</h1>
      <h2 style="margin:8px 0;${isEmailMode?'color:#dbeafe;':'color:#4b5563;'}">${esc(label)}${inventoryNote}</h2>
      <div class="muted" style="${isEmailMode?'color:#bfdbfe;':''}">
        Generado: ${now.toFormat("dd LLL yyyy, HH:mm")} (${esc(tz)})
        ${comparison ? ` - vs anterior: <strong style="color:${comparison.revChange >= 0 ? '#10b981' : '#ef4444'}">${comparison.revChange >= 0 ? 'up' : 'down'} ${Math.abs(comparison.revPercent)}%</strong>` : ''}
      </div>
    </header>

    <div class="stats-grid">
      <div class="stat-card">
        <div style="font-size:20px;margin-bottom:4px;">Productos</div>
        <div class="stat-number">${rows.length}</div>
        <div class="stat-label">Productos unicos</div>
      </div>
      <div class="stat-card">
        <div style="font-size:20px;margin-bottom:4px;">Ordenes</div>
        <div class="stat-number">${orders.length}</div>
        <div class="stat-label">Ordenes procesadas</div>
      </div>
      <div class="stat-card">
        <div style="font-size:20px;margin-bottom:4px;">Ingresos</div>
        <div class="stat-number">${money(totRev)}</div>
        <div class="stat-label">Total vendite</div>
      </div>
      <div class="stat-card">
        <div style="font-size:20px;margin-bottom:4px;">Ticket</div>
        <div class="stat-number">${money(totRev/orders.length || 0)}</div>
        <div class="stat-label">Ticket promedio</div>
      </div>
      <div class="stat-card">
        <div style="font-size:20px;margin-bottom:4px;">Stock</div>
        <div class="stat-number" style="color:#dc2626;">${rows.filter(r=>Number(r.inventoryAvailable||0)<=1).length}</div>
        <div class="stat-label">Stock critico</div>
      </div>
    </div>

    ${renderLocationBreakdown(locationStats, isEmailMode)}
    ${renderDeadStockAlert(deadStockData, isEmailMode)}
    ${renderROPTable(ropRows, isEmailMode)}
    ${renderProductsTable(rows, isEmailMode)}
    ${!isEmailMode ? renderABCSummary(abcData) : ''}
    ${renderConversionAnalysis(conversions, isEmailMode)}
    ${chartsHTML(orders, isEmailMode, locationStats)}

    <footer style="margin-top:40px;padding-top:20px;border-top:1px solid #e5e7eb;text-align:center;">
      <div class="muted">
        <div style="margin-bottom:8px;">
          <strong>Navigation:</strong>
          <a href="?period=daily&today=1" style="color:#2563eb;">Hoy</a> |
          <a href="?period=daily" style="color:#2563eb;">Ayer</a> |
          <a href="?period=weekly" style="color:#2563eb;">Semana</a> |
          <a href="?period=monthly" style="color:#2563eb;">Mes</a>
        </div>
        ${!isEmailMode ? `
        <div style="margin-bottom:8px;">
          <strong>Inventario:</strong>
          <a href="?period=daily&include_all_locations=0" style="color:#059669;">Solo Activas</a> |
          <a href="?period=daily&include_all_locations=1" style="color:#dc2626;">Todas las Locations</a>
        </div>
        <div>
          Performance: ${timing?.total || 0}ms |
          <a href="?preview=1" style="color:#10b981;">Preview Email</a> |
          <a href="?debug=1" style="color:#8b5cf6;">Debug</a> |
          <a href="/api/debug-inventory" style="color:#dc2626;">Debug Inventory</a>
        </div>
        ` : ''}
      </div>
    </footer>
  </div>
</body>
</html>`;
}          
