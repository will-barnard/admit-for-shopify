/**
 * Publish an event to the storefront as a Shopify product.
 *
 * One product per event, one variant per ticket type. This inverts the original
 * direction - the merchant used to create the product and point a ticket type
 * at a variant - so the ticket types' shopify_variant_id values are now filled
 * in from what Shopify returns, and the order-matching pipeline downstream is
 * unchanged: it still matches a line item on variant id, then SKU.
 *
 * Identity is an `admit.event_id` metafield, not the stored product id.
 * productSet upserts on it, so re-publishing is idempotent even if
 * events.shopify_product_id is empty or stale, and two clicks of Publish cannot
 * produce two products.
 *
 * productSet is DECLARATIVE: variants absent from the input are removed. That
 * is what makes it the right call - the event is the source of truth and the
 * product should end up matching it exactly - but it also means the input must
 * always carry every ticket type, which is why buildProductInput takes the full
 * list rather than a delta.
 *
 * The event's date and location go up as product metafields so a theme can
 * render an events listing without calling back here. They are stored under the
 * `admit` namespace with storefront access, and the block in
 * extensions/ reads them.
 */

const db = require('../config/database');
const { forShop, assertNoUserErrors, gid } = require('../shopify/admin-api');

const NAMESPACE = 'admit';
const OPTION_NAME = 'Ticket';

const PRIMARY_LOCATION_QUERY = `
  query AdmitPrimaryLocation {
    location { id name }
  }
`;

/**
 * Where stock is held. Tickets are not really stocked anywhere, but Shopify
 * needs a location to hold a number against, and the shop's default is the one
 * every store has.
 */
async function primaryLocationId(shopId) {
  try {
    const data = await forShop(shopId, PRIMARY_LOCATION_QUERY, {});
    return data?.location?.id || null;
  } catch (error) {
    // Not fatal: without it the variant is still tracked, it just starts at
    // zero available and the count is set in Shopify.
    console.warn('Could not read the primary location, publishing without an opening stock level:', error.message);
    return null;
  }
}

const PUBLISH_MUTATION = `
  mutation AdmitPublishEvent($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
    productSet(input: $input, identifier: $identifier, synchronous: true) {
      product {
        id
        handle
        status
        onlineStoreUrl
        variants(first: 100) {
          nodes { id title sku price }
        }
      }
      userErrors { field message code }
    }
  }
`;

/** Naive local timestamps, formatted the way a metafield of type date_time wants. */
function isoish(value) {
  if (!value) return null;
  return String(value).replace(' ', 'T').slice(0, 19);
}

function metafieldsFor(event) {
  const fields = [
    { namespace: NAMESPACE, key: 'event_id', type: 'single_line_text_field', value: String(event.id) },
    { namespace: NAMESPACE, key: 'starts_at', type: 'date_time', value: isoish(event.starts_at) },
  ];
  if (event.ends_at) {
    fields.push({ namespace: NAMESPACE, key: 'ends_at', type: 'date_time', value: isoish(event.ends_at) });
  }
  if (event.location) {
    fields.push({ namespace: NAMESPACE, key: 'location', type: 'single_line_text_field', value: event.location });
  }
  return fields;
}

/**
 * @param {object} event
 * @param {Array} ticketTypes  every type the event has, in display order
 * @param {object} options     { collectionIds, status }
 */
function buildProductInput(event, ticketTypes, { collectionIds = [], status, locationId = null } = {}) {
  const sellable = ticketTypes.filter((t) => t.active !== false);
  if (sellable.length === 0) {
    throw new Error('An event needs at least one active ticket type before it can be published.');
  }

  // Variant titles must be unique within a product - they are the option value.
  const seen = new Set();
  const variants = sellable.map((t, index) => {
    let name = (t.name || 'General Admission').trim();
    while (seen.has(name.toLowerCase())) name = `${name} (${index + 1})`;
    seen.add(name.toLowerCase());

    const variant = {
      optionValues: [{ optionName: OPTION_NAME, name }],
      price: t.price == null ? '0.00' : String(t.price),
      position: index + 1,
      // Shopify owns the count. It tracks stock and REFUSES to sell past it, so
      // a sold-out show stops selling at the checkout rather than after the
      // fact - the app finding out from a webhook is always too late.
      inventoryItem: { tracked: true, requiresShipping: false },
      inventoryPolicy: 'DENY',
      taxable: true,
      metafields: [
        { namespace: NAMESPACE, key: 'ticket_type_id', type: 'single_line_text_field', value: String(t.id) },
      ],
    };
    // Reuse the existing variant where we already know it, so a rename edits
    // rather than replaces - replacing would orphan tickets already sold.
    if (t.shopify_variant_id) variant.id = `gid://shopify/ProductVariant/${t.shopify_variant_id}`;
    if (t.shopify_sku) variant.sku = t.shopify_sku;

    // Stock is seeded ONCE, when the variant is first created. Re-publishing
    // must not resend it: Shopify decrements as tickets sell, so setting it
    // again would silently restore the count and let the show oversell. After
    // the first publish the number in Shopify is the live one, and that is
    // where it gets changed.
    const isNew = !t.shopify_variant_id;
    if (isNew && t.capacity != null && locationId) {
      variant.inventoryQuantities = [
        { locationId, name: 'available', quantity: Number(t.capacity) },
      ];
    }
    return variant;
  });

  return {
    title: event.name,
    descriptionHtml: event.description || '',
    status: status || (event.active === false ? 'DRAFT' : 'ACTIVE'),
    productType: 'Event Ticket',
    tags: ['admit-event'],
    productOptions: [{
      name: OPTION_NAME,
      position: 1,
      values: variants.map((v) => ({ name: v.optionValues[0].name })),
    }],
    variants,
    metafields: metafieldsFor(event),
    ...(collectionIds.length ? { collections: collectionIds } : {}),
  };
}

async function loadEvent(shopId, eventId) {
  const event = (await db.query(
    'SELECT * FROM events WHERE id = $1 AND shop_id = $2', [eventId, shopId]
  )).rows[0];
  if (!event) return null;

  const ticketTypes = (await db.query(
    `SELECT * FROM event_ticket_types WHERE event_id = $1 AND shop_id = $2 ORDER BY sort_order, id`,
    [eventId, shopId]
  )).rows;
  return { event, ticketTypes };
}

/**
 * Match the variants Shopify returned back onto our ticket types, and store the
 * ids. Matched by option title, because that is what we set it from - SKU is
 * optional and the id is what we are trying to learn.
 */
async function recordVariantIds(shopId, ticketTypes, variantNodes) {
  const byTitle = new Map(variantNodes.map((v) => [String(v.title).toLowerCase(), v]));
  const updated = [];

  for (const type of ticketTypes) {
    if (type.active === false) continue;
    const node = byTitle.get(String(type.name).trim().toLowerCase());
    const numericId = gid.toNumeric(node?.id);
    if (!numericId || String(type.shopify_variant_id) === numericId) continue;

    await db.query(
      'UPDATE event_ticket_types SET shopify_variant_id = $1, updated_at = NOW() WHERE id = $2 AND shop_id = $3',
      [numericId, type.id, shopId]
    );
    updated.push({ ticket_type_id: type.id, name: type.name, shopify_variant_id: numericId });
  }
  return updated;
}

async function publishEvent(shopId, eventId, { collectionIds = [], status } = {}) {
  const loaded = await loadEvent(shopId, eventId);
  if (!loaded) return null;
  const { event, ticketTypes } = loaded;

  // Only needed when there is a new variant to seed.
  const needsLocation = ticketTypes.some((t) => t.active !== false && !t.shopify_variant_id && t.capacity != null);
  const locationId = needsLocation ? await primaryLocationId(shopId) : null;

  const input = buildProductInput(event, ticketTypes, { collectionIds, status, locationId });

  let data;
  try {
    data = await forShop(shopId, PUBLISH_MUTATION, {
      input,
      // Upsert on the event id, so this is safe to run twice.
      identifier: { customId: { namespace: NAMESPACE, key: 'event_id', value: String(event.id) } },
    });
    assertNoUserErrors(data?.productSet, 'Publishing the event');
  } catch (error) {
    await db.query(
      'UPDATE events SET publish_error = $1, updated_at = NOW() WHERE id = $2 AND shop_id = $3',
      [error.message || 'Unknown error', eventId, shopId]
    );
    throw error;
  }

  const product = data.productSet.product;
  const variantNodes = product?.variants?.nodes || [];
  const mapped = await recordVariantIds(shopId, ticketTypes, variantNodes);

  const saved = await db.query(
    `UPDATE events
        SET shopify_product_id = $1, shopify_handle = $2, published_at = NOW(),
            publish_error = NULL, updated_at = NOW()
      WHERE id = $3 AND shop_id = $4
      RETURNING *`,
    [gid.toNumeric(product.id), product.handle, eventId, shopId]
  );

  return {
    event: saved.rows[0],
    product: {
      id: gid.toNumeric(product.id),
      handle: product.handle,
      status: product.status,
      onlineStoreUrl: product.onlineStoreUrl || null,
    },
    mappedVariants: mapped,
  };
}

/**
 * Take the event off the storefront without deleting anything. Draft rather than
 * delete, deliberately: the product carries the order history for every ticket
 * already sold, and deleting it to "unpublish" would take that with it.
 */
async function unpublishEvent(shopId, eventId) {
  const loaded = await loadEvent(shopId, eventId);
  if (!loaded) return null;
  const { event, ticketTypes } = loaded;
  if (!event.published_at) return { event, product: null, alreadyUnpublished: true };

  const input = buildProductInput(event, ticketTypes, { status: 'DRAFT' });
  const data = await forShop(shopId, PUBLISH_MUTATION, {
    input,
    identifier: { customId: { namespace: NAMESPACE, key: 'event_id', value: String(event.id) } },
  });
  assertNoUserErrors(data?.productSet, 'Unpublishing the event');

  const saved = await db.query(
    'UPDATE events SET published_at = NULL, updated_at = NOW() WHERE id = $1 AND shop_id = $2 RETURNING *',
    [eventId, shopId]
  );
  return { event: saved.rows[0], product: { status: data.productSet.product?.status } };
}

module.exports = {
  publishEvent,
  unpublishEvent,
  buildProductInput,
  metafieldsFor,
  NAMESPACE,
  OPTION_NAME,
  PUBLISH_MUTATION,
};
