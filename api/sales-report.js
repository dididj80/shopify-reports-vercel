// /api/debug-inventory.js - Debug inventario separato
import { DateTime } from "luxon";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const REST = (p, ver = "2024-07") => `https://${SHOP}/admin/api/${ver}${p}`;

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

const chunk = (arr, n) => Array.from({length: Math.ceil(arr.length/n)}, (_,i)=>arr.slice(i*n,(i+1)*n));

// Debug completo di un singolo variant
async function debugVariantInventory(variantId) {
  console.log(`Debug Variant ID: ${variantId}`);
  
  try {
    // 1. Fetch variant base info
    const variantData = await shopFetchJson(REST(`/variants/${variantId}.json`));
    const variant = variantData.variant;
    
    // 2. Fetch product info per avere più contesto
    const productData = await shopFetchJson(REST(`/products/${variant.product_id}.json`));
    const product = productData.product;
    
    console.log("PRODUCT & VARIANT INFO:", {
      product_title: product.title,
      variant_id: variant.id,
      variant_title: variant.title,
      sku: variant.sku || "NO SKU",
      barcode: variant.barcode || "NO BARCODE",
      inventory_item_id: variant.inventory_item_id,
      inventory_quantity: variant.inventory_quantity,
      inventory_management: variant.inventory_management,
      inventory_policy: variant.inventory_policy,
      price: variant.price
    });

    // 3. Fetch inventory item details
    if (variant.inventory_item_id) {
      const itemData = await shopFetchJson(REST(`/inventory_items/${variant.inventory_item_id}.json`));
      const item = itemData.inventory_item;
      
      console.log("INVENTORY ITEM:", {
        id: item.id,
        sku: item.sku,
        tracked: item.tracked,
        cost: item.cost || "N/A",
        requires_shipping: item.requires_shipping
      });

      // 4. Fetch ALL inventory levels for this item
      const levelsData = await shopFetchJson(REST(`/inventory_levels.json?inventory_item_ids=${variant.inventory_item_id}`));
      
      console.log("INVENTORY LEVELS PER LOCATION:");
      let totalAllLocations = 0;
      let totalActiveLocations = 0;
      const locationDetails = [];
      
      for (const level of levelsData.inventory_levels || []) {
        // Fetch location details
        const locationData = await shopFetchJson(REST(`/locations/${level.location_id}.json`));
        const location = locationData.location;
        
        const available = Number(level.available || 0);
        totalAllLocations += available;
        
        if (location.active) {
          totalActiveLocations += available;
        }
        
        const locationInfo = {
          name: location.name,
          id: location.id,
          active: location.active,
          available: available,
          updated_at: level.updated_at
        };
        
        locationDetails.push(locationInfo);
        
        console.log(`  Location: ${location.name} (ID: ${location.id})`);
        console.log(`    Active: ${location.active ? 'SI' : 'NO'}`);
        console.log(`    Available: ${available}`);
        console.log(`    Updated: ${level.updated_at}`);
        console.log("    ---");
      }
      
      console.log(`RIASSUNTO INVENTARIO:`);
      console.log(`  SKU: ${variant.sku || 'N/A'}`);
      console.log(`  Variant inventory_quantity: ${variant.inventory_quantity}`);
      console.log(`  Somma TUTTE le location: ${totalAllLocations}`);
      console.log(`  Somma SOLO location ATTIVE: ${totalActiveLocations}`);
      console.log(`  Differenza (attive vs variant): ${totalActiveLocations - variant.inventory_quantity}`);
      
      return {
        product_title: product.title,
        variant_title: variant.title,
        variantId: variant.id,
        sku: variant.sku || null,
        barcode: variant.barcode || null,
        variantQuantity: variant.inventory_quantity,
        allLocationsSum: totalAllLocations,
        activeLocationsSum: totalActiveLocations,
        differenceFromVariant: totalActiveLocations - variant.inventory_quantity,
        inventory_management: variant.inventory_management,
        tracked: item?.tracked,
        locations: locationDetails
      };
    }
    
  } catch (error) {
    console.error(`Error debugging variant ${variantId}:`, error.message);
    return { error: error.message };
  }
}

// Helper: Trova variant ID tramite SKU o barcode
async function findVariantBySku(sku) {
  try {
    // Cerca nei prodotti
    const productsData = await shopFetchJson(REST(`/products.json?limit=250`));
    
    for (const product of productsData.products || []) {
      for (const variant of product.variants || []) {
        if (variant.sku === sku || variant.barcode === sku) {
          return {
            variant_id: variant.id,
            product_title: product.title,
            variant_title: variant.title,
            sku: variant.sku,
            barcode: variant.barcode,
            found_by: variant.sku === sku ? 'sku' : 'barcode'
          };
        }
      }
    }
    return null;
  } catch (error) {
    console.error('Error finding variant by SKU:', error.message);
    return null;
  }
}

// Confronta metodi di calcolo inventario
async function compareInventoryMethods(sampleSize = 10) {
  const results = [];
  
  try {
    // Prendi alcuni variant ID dai recenti ordini
    const ordersData = await shopFetchJson(REST('/orders.json?limit=50&status=any'));
    const variantIds = new Set();
    
    for (const order of ordersData.orders || []) {
      for (const item of order.line_items || []) {
        if (item.variant_id && variantIds.size < sampleSize) {
          variantIds.add(item.variant_id);
        }
      }
    }
    
    for (const vid of Array.from(variantIds)) {
      try {
        // Metodo 1: Variant inventory_quantity (vecchio)
        const variantData = await shopFetchJson(REST(`/variants/${vid}.json`));
        const variant = variantData.variant;
        
        const oldMethod = variant.inventory_quantity || 0;
        
        // Metodo 2: Somma inventory levels (nuovo)
        let newMethodActive = 0;
        let newMethodAll = 0;
        
        if (variant.inventory_item_id) {
          const levelsData = await shopFetchJson(REST(`/inventory_levels.json?inventory_item_ids=${variant.inventory_item_id}`));
          
          for (const level of levelsData.inventory_levels || []) {
            const available = Number(level.available || 0);
            newMethodAll += available;
            
            // Check se location è attiva
            const locationData = await shopFetchJson(REST(`/locations/${level.location_id}.json`));
            if (locationData.location.active) {
              newMethodActive += available;
            }
          }
        }
        
        results.push({
          variantId: vid,
          sku: variant.sku || `ID:${vid}`,
          product_title: variant.title,
          oldMethod: oldMethod,
          newMethodActive: newMethodActive,
          newMethodAll: newMethodAll,
          differenceActive: newMethodActive - oldMethod,
          differenceAll: newMethodAll - oldMethod,
          inventory_management: variant.inventory_management
        });
        
      } catch (error) {
        console.error(`Error comparing variant ${vid}:`, error.message);
      }
    }
    
    return results;
    
  } catch (error) {
    console.error('Error in comparison:', error.message);
    return [];
  }
}

// Ottieni info su tutte le location del negozio
async function getShopLocations() {
  try {
    const { locations } = await shopFetchJson(REST('/locations.json'));
    return locations.map(loc => ({
      id: loc.id,
      name: loc.name,
      active: loc.active,
      address1: loc.address1 || '',
      city: loc.city || '',
      created_at: loc.created_at,
      updated_at: loc.updated_at
    }));
  } catch (error) {
    console.error('Error fetching locations:', error.message);
    return [];
  }
}

// MAIN HANDLER
export default async function handler(req, res) {
  const { 
    variant_id, 
    sku,
    barcode,
    compare_methods = false, 
    sample_size = 10,
    show_locations = false
  } = req.query;
  
  try {
    
    // Mostra le location disponibili
    if (show_locations === "true" || show_locations === "1") {
      const locations = await getShopLocations();
      return res.json({
        success: true,
        message: "Location del negozio",
        locations,
        total: locations.length,
        active: locations.filter(l => l.active).length,
        inactive: locations.filter(l => !l.active).length
      });
    }
    
    // Cerca per SKU o barcode
    if (sku || barcode) {
      const searchTerm = sku || barcode;
      const foundVariant = await findVariantBySku(searchTerm);
      
      if (!foundVariant) {
        return res.json({
          success: false,
          error: `Nessun variant trovato con ${sku ? 'SKU' : 'barcode'}: ${searchTerm}`,
          suggestion: "Verifica che il SKU/barcode sia corretto"
        });
      }
      
      console.log(`Trovato variant ${foundVariant.variant_id} per ${foundVariant.found_by}: ${searchTerm}`);
      
      // Fai il debug del variant trovato
      const result = await debugVariantInventory(foundVariant.variant_id);
      return res.json({ 
        success: true, 
        found_by: foundVariant.found_by,
        search_term: searchTerm,
        debug: result 
      });
    }
    
    // Debug di variant specifico
    if (variant_id) {
      const result = await debugVariantInventory(variant_id);
      return res.json({ success: true, debug: result });
    }
    
    // Confronta metodi su un campione
    if (compare_methods === "true" || compare_methods === "1") {
      const comparison = await compareInventoryMethods(parseInt(sample_size));
      
      const summary = {
        total_products: comparison.length,
        with_differences_active: comparison.filter(r => r.differenceActive !== 0).length,
        with_differences_all: comparison.filter(r => r.differenceAll !== 0).length,
        avg_difference_active: comparison.reduce((sum, r) => sum + Math.abs(r.differenceActive), 0) / comparison.length || 0,
        avg_difference_all: comparison.reduce((sum, r) => sum + Math.abs(r.differenceAll), 0) / comparison.length || 0,
        problems: comparison.filter(r => Math.abs(r.differenceActive) > 0 || Math.abs(r.differenceAll) > 0)
      };
      
      return res.json({ 
        success: true, 
        comparison,
        summary,
        recommendation: summary.with_differences_active > 0 ? 
          "Ci sono discrepanze nell'inventario. Usa 'Solo location attive' per correggere." :
          "Inventario corretto! Il sistema attuale funziona bene."
      });
    }
    
    // Default: istruzioni d'uso
    const baseUrl = req.headers.host ? `https://${req.headers.host}` : 'https://tuo-dominio.vercel.app';
    
    res.json({ 
      success: true, 
      message: "Inventory Debug API - Sistema di test inventario",
      usage: {
        by_variant_id: `${baseUrl}/api/debug-inventory?variant_id=XXXX`,
        by_sku: `${baseUrl}/api/debug-inventory?sku=TUO-SKU-123`,
        by_barcode: `${baseUrl}/api/debug-inventory?barcode=123456789`,
        compare_methods: `${baseUrl}/api/debug-inventory?compare_methods=true&sample_size=10`,
        show_locations: `${baseUrl}/api/debug-inventory?show_locations=true`,
        list_products: `${baseUrl}/api/debug-inventory?list_products=true&limit=20`
      },
      examples: {
        "Test prodotto specifico": "?barcode=7508006184500",
        "Lista prodotti disponibili": "?list_products=true&limit=10",
        "Confronta metodi inventario": "?compare_methods=true",
        "Vedi tutte le location": "?show_locations=true"
      },
      tip: "Per trovare il variant ID, vai in Shopify Admin > Prodotti > [prodotto] > [variante] e guarda nella URL"
    });
    
  } catch (error) {
    console.error("Debug inventory error:", error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      tip: "Verifica che SHOPIFY_SHOP e SHOPIFY_ADMIN_TOKEN siano configurati correttamente"
    });
  }
}
