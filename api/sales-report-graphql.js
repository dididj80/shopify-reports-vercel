// /api/sales-report-graphql.js - TEST ENDPOINT con GraphQL
// Questo è identico a sales-report.js MA usa GraphQL invece di REST per l'inventory

import { DateTime } from "luxon";
import { 
  fetchVariantsInventoryGraphQL,
  testConnection 
} from './shopify-graphql.js';

// ========================================
// IMPORTA LE FUNZIONI COMUNI DA REST
// ========================================

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const REST = (p, ver = "2024-07") => `https://${SHOP}/admin/api/${ver}${p}`;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const money = (n) => new Intl.NumberFormat("es-MX",{style:"currency",currency:"MXN"}).format(Number(n||0));

function getOrderRevenue(order) {
  return Number(order.total_price || 0);
}

async function getShopTZ() {
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
    if (todayFlag) {
      start = now.startOf("week"); 
      end = now.endOf("week");
    } else {
      const lastWeek = now.minus({weeks: 1});
      start = lastWeek.startOf("week"); 
      end = lastWeek.endOf("week");
    }
  } else if (period === "monthly") {
    if (todayFlag) {
      start = now.startOf("month"); 
      end = now.endOf("month");
    } else {
      const lastMonth = now.minus({months: 1});
      start = lastMonth.startOf("month"); 
      end = lastMonth.endOf("month");
    }
  }
  
  return { tz, now, start, end };
}

async function fetchWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      headers: { "X-Shopify-Access-Token": TOKEN },
      signal: controller.signal
    });
    
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${url} -> ${response.status} ${text}`.slice(0, 500));
    }
    
    return { json: text ? JSON.parse(text) : {}, link: response.headers.get("link") || "" };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchOrdersPaidInRange(start, end) {
  const base = `/orders.json?status=any&financial_status=paid&limit=250` +
    `&created_at_min=${encodeURIComponent(start.toUTC().toISO())}` +
    `&created_at_max=${encodeURIComponent(end.toUTC().toISO())}`;

  let url = REST(base);
  const out = [];
  let pageCount = 0;
  
  for (;;) {
    if (pageCount++ > 100) break;
    
    const { json, link } = await fetchWithTimeout(url);
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

// ========================================
// PROCESS PRODUCTS CON GRAPHQL
// ========================================

async function processProductsCompleteGraphQL(orders, includeAllLocations) {
  const byVariant = new Map();
  const variantIds = new Set();
  
  // Aggrega dati dagli ordini
  for (const o of orders) {
    for (const li of o.line_items || []) {
      const key = li.variant_id ?? `SKU:${li.sku || li.title}`;
      const prev = byVariant.get(key) || {
        productTitle: li.title || li.name || "Producto", 
        variantTitle: li.variant_title || "Default Title",
        sku: li.sku || "", 
        unitPrice: Number(li.price || 0),
        soldQty: 0, 
        revenue: 0,
        variantId: li.variant_id || null,
        inventory_item_id: null,
        inventoryAvailable: null
      };
      
      prev.soldQty += Number(li.quantity || 0);
      
      const orderSubtotal = Number(o.subtotal_price || 0);
      const lineItemSubtotal = Number(li.price || 0) * Number(li.quantity || 0);
      const orderRevenue = getOrderRevenue(o);
      const lineItemRevenue = orderSubtotal > 0 ? (lineItemSubtotal / orderSubtotal) * orderRevenue : 0;
      prev.revenue += lineItemRevenue;
      
      byVariant.set(key, prev);
      
      if (li.variant_id) variantIds.add(li.variant_id);
    }
  }
  
  const rows = Array.from(byVariant.values()).sort((a,b) => b.soldQty - a.soldQty || b.revenue - a.revenue);
  
  // 🚀 USA GRAPHQL INVECE DI REST!
  if (variantIds.size > 0) {
    console.log(`🚀 Using GraphQL to fetch ${variantIds.size} variants...`);
    const graphqlStart = Date.now();
    
    const variantInfo = await fetchVariantsInventoryGraphQL([...variantIds], includeAllLocations);
    
    console.log(`✅ GraphQL completed in ${Date.now() - graphqlStart}ms`);
    
    // Applica i dati ai rows
    for (const r of rows) {
      const info = r.variantId ? variantInfo.get(String(r.variantId)) : null;
      if (info) {
        r.inventory_item_id = info.inventory_item_id;
        r.inventoryAvailable = info.inventoryAvailable;
        r._variantFallbackQty = info._variantFallbackQty;
        r._variantMgmt = info._variantMgmt;
        r.compare_at_price = info.compare_at_price;
        r._fromGraphQL = true;
      }
    }
  }
    
  return { rows, variantIds: [...variantIds] };
}

// ========================================
// MAIN HANDLER
// ========================================

export default async function handler(req, res) {
  const startTime = Date.now();
  const timing = {};
  
  try {
    // Test connessione GraphQL
    const connectionOk = await testConnection();
    if (!connectionOk) {
      throw new Error('GraphQL connection failed');
    }
    
    const period = (req.query.period || "daily").toLowerCase();
    const today = req.query.today === "1";
    const includeAllLocations = req.query.include_all_locations === "1";
    const debug = req.query.debug === "1";

    const { tz, now, start, end } = await computeRange(period, today);
    
    // Fetch orders (stesso REST API)
    const t1 = Date.now();
    const orders = await fetchOrdersPaidInRange(start, end);
    timing.orders = Date.now() - t1;

    // Process products CON GRAPHQL
    const t2 = Date.now();
    const { rows, variantIds } = await processProductsCompleteGraphQL(orders, includeAllLocations);
    timing.processing = Date.now() - t2;
    
    timing.total = Date.now() - startTime;

    const label = period==="daily" ? `${today ? "Hoy" : "Ayer"} ${start.toFormat("dd LLL yyyy")}` :
                  period==="weekly" ? `Semana ${start.toFormat("dd LLL")} - ${end.toFormat("dd LLL yyyy")}` :
                  `${start.toFormat("LLLL yyyy")}`;
    
    const totRev = orders.reduce((s,o) => s + getOrderRevenue(o), 0);
    
    // Conta quanti usano GraphQL
    const graphqlUsage = rows.filter(r => r._fromGraphQL).length;
    
    // Response semplificata per test
    return res.status(200).json({
      success: true,
      method: 'GraphQL',
      label,
      timing,
      stats: {
        totalProducts: rows.length,
        totalRevenue: totRev,
        totalOrders: orders.length,
        graphqlUsage: `${graphqlUsage}/${rows.length} products`,
        includeAllLocations
      },
      comparison: {
        expectedRESTTime: `~${(variantIds.length * 0.2).toFixed(0)}s`,
        actualGraphQLTime: `${(timing.processing / 1000).toFixed(1)}s`,
        speedup: `~${(variantIds.length * 0.2 / (timing.processing / 1000)).toFixed(1)}x faster`
      },
      // Top 10 prodotti per verifica
      topProducts: rows.slice(0, 10).map(r => ({
        title: r.productTitle,
        sold: r.soldQty,
        revenue: money(r.revenue),
        stock: r.inventoryAvailable,
        fromGraphQL: r._fromGraphQL || false
      })),
      debug: debug ? {
        variantIds: variantIds.length,
        timing,
        sampleRow: rows[0]
      } : undefined
    });
    
  } catch (err) {
    console.error("GraphQL report error:", err);
    return res.status(500).json({ 
      success: false, 
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
      method: 'GraphQL'
    });
  }
}