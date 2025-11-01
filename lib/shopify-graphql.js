// /lib/shopify-graphql.js - GraphQL API Implementation
// Questa libreria implementa le stesse funzionalità di REST ma usando GraphQL

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const GRAPHQL_URL = `https://${SHOP}/admin/api/2024-10/graphql.json`;

// ========================================
// CORE GRAPHQL REQUEST
// ========================================

/**
 * Esegue una query GraphQL verso Shopify
 * @param {string} query - GraphQL query string
 * @param {object} variables - Variabili per la query
 * @returns {Promise<object>} - Data dalla risposta
 */
async function graphqlRequest(query, variables = {}) {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await response.json();

  if (json.errors) {
    console.error('GraphQL Errors:', JSON.stringify(json.errors, null, 2));
    throw new Error(`GraphQL Error: ${json.errors.map(e => e.message).join(', ')}`);
  }

  if (!response.ok) {
    throw new Error(`GraphQL HTTP Error: ${response.status} ${response.statusText}`);
  }

  return json.data;
}

// ========================================
// TEST CONNECTION
// ========================================

/**
 * Testa la connessione GraphQL
 * @returns {Promise<boolean>}
 */
async function testConnection() {
  const TEST_QUERY = `
    query {
      shop {
        name
        email
        currencyCode
      }
    }
  `;

  try {
    const data = await graphqlRequest(TEST_QUERY);
    console.log('✅ GraphQL connection OK:', data.shop.name);
    return true;
  } catch (err) {
    console.error('❌ GraphQL connection failed:', err.message);
    return false;
  }
}

// ========================================
// FETCH VARIANTS WITH INVENTORY (MAIN FUNCTION)
// ========================================

/**
 * Recupera info variants + inventory in 1 sola query GraphQL
 * Equivalente a: fetchVariantsByIds() + fetchInventoryLevelsForItems()
 * 
 * @param {Array<number>} variantIds - Array di variant IDs (numeri REST)
 * @param {boolean} includeInactive - Include anche location inattive
 * @returns {Promise<Map>} - Map con variant_id => dati completi
 */
async function fetchVariantsInventoryGraphQL(variantIds, includeInactive = false) {
  if (!variantIds.length) return new Map();

  // Converti REST IDs (numeri) a GraphQL GIDs (stringhe)
  const gids = variantIds.map(id => `gid://shopify/ProductVariant/${id}`);

  // Query completa che prende tutto in 1 colpo
  const query = `
    query getVariantsWithInventory($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          legacyResourceId
          sku
          price
          compareAtPrice
          inventoryQuantity
          inventoryItem {
            id
            inventoryLevels(first: 50) {
              edges {
                node {
                  available
                  location {
                    id
                    legacyResourceId
                    name
                    isActive
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await graphqlRequest(query, { ids: gids });

  // Trasforma in formato compatibile con REST
  const result = new Map();

  for (const node of data.nodes) {
    if (!node) continue; // Skip null nodes

    const variantId = String(node.legacyResourceId);

    // Calcola inventory totale sommando le location
    let totalInventory = 0;
    if (node.inventoryItem?.inventoryLevels) {
      for (const edge of node.inventoryItem.inventoryLevels.edges) {
        const location = edge.node.location;
        const available = Number(edge.node.available || 0);

        // Filtra per location attive se richiesto
        if (!includeInactive && !location.isActive) {
          continue;
        }

        totalInventory += available;
      }
    }

    // Estrai inventory_item_id dal GID
    const inventoryItemId = node.inventoryItem?.id.match(/\d+$/)?.[0];

    // Formato compatibile con REST API
    result.set(variantId, {
      inventory_item_id: inventoryItemId,
      inventory_quantity: node.inventoryQuantity || 0,
      inventory_management: "shopify", // Default value since field removed from API
      sku: node.sku || "",
      price: node.price || "0",
      compare_at_price: node.compareAtPrice,
      inventoryAvailable: totalInventory,
      _fromGraphQL: true,
      _variantFallbackQty: node.inventoryQuantity || 0,
      _variantMgmt: "shopify" // Default value
    });
  }

  console.log(`✅ GraphQL fetched ${result.size} variants with inventory in 1 query`);

  return result;
}

// ========================================
// HELPER: Converti GID a REST ID
// ========================================

/**
 * Estrae l'ID numerico da un GraphQL GID
 * @param {string} gid - GraphQL GID (es: "gid://shopify/Product/123")
 * @returns {string} - ID numerico come stringa
 */
function extractRestId(gid) {
  const match = gid?.match(/\d+$/);
  return match ? match[0] : null;
}

/**
 * Converti REST ID a GraphQL GID
 * @param {number|string} id - REST ID
 * @param {string} resourceType - Tipo risorsa (Product, ProductVariant, etc)
 * @returns {string} - GraphQL GID
 */
function toGraphQLId(id, resourceType = 'ProductVariant') {
  return `gid://shopify/${resourceType}/${id}`;
}

// ========================================
// BATCH PROCESSING (per molti prodotti)
// ========================================

/**
 * Process variants in batch con GraphQL
 * GraphQL può gestire fino a 250 items per query, molto più efficiente di REST
 * 
 * @param {Array<number>} variantIds - Array di variant IDs
 * @param {boolean} includeInactive - Include location inattive
 * @returns {Promise<Map>}
 */
async function fetchVariantsInventoryBatch(variantIds, includeInactive = false) {
  const BATCH_SIZE = 250; // GraphQL può gestire più items di REST
  const batches = [];

  for (let i = 0; i < variantIds.length; i += BATCH_SIZE) {
    batches.push(variantIds.slice(i, i + BATCH_SIZE));
  }

  console.log(`📦 Processing ${variantIds.length} variants in ${batches.length} batches`);

  const results = new Map();

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`Processing batch ${i + 1}/${batches.length} (${batch.length} items)`);

    const batchResult = await fetchVariantsInventoryGraphQL(batch, includeInactive);

    // Merge results
    for (const [key, value] of batchResult.entries()) {
      results.set(key, value);
    }

    // Rate limiting: aspetta un po' tra i batch
    if (i < batches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return results;
}

// ========================================
// EXPORTS
// ========================================

export {
  graphqlRequest,
  testConnection,
  fetchVariantsInventoryGraphQL,
  fetchVariantsInventoryBatch,
  extractRestId,
  toGraphQLId
};