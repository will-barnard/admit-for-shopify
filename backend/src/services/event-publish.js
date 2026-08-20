/**
 * Publish an event to the storefront as a Shopify product.
 *
 * One product per event, one variant per ticket type. This inverts the original
 * direction - the merchant used to create the product and point a ticket type
 * at a variant - so the ticket types' shopify_variant_id values are now filled
 * in from what Shopify returns, and the order-matching pipeline downstream is
 * unchanged: it still matches a line item on variant id, then SKU.
 *
 * Identity is the product HANDLE, derived from the event id, with the stored
 * product id preferred when we have one. Two clicks of Publish cannot produce
 * two products.
 *
 * It was originally the `admit.event_id` metafield via productSet's `customId`,
 * which reads better - but the real API refuses it with METAFIELD_MISMATCH even
 * when the metafield is present with a matching value and a unique-values
 * definition exists. The stubbed test could not see that, because the stub
 * implemented the contract as documented rather than as built. A handle needs
 * no definition, no uniqueness capability, and no app-reserved-namespace
 * resolution, so it is the sturdier choice anyway.
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
const { ensureDefinitions } = require('../shopify/metafield-definitions');

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

const ONLINE_STORE_QUERY = `
  query AdmitOnlineStore {
    publications(first: 20, catalogType: APP) { nodes { id name } }
  }
`;

const PUBLISH_TO_CHANNEL = `
  mutation AdmitPublishToChannel($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      publishable { ... on Product { id onlineStoreUrl } }
      userErrors { field message }
    }
  }
`;

/**
 * productSet creates the product but does NOT put it on any sales channel, so a
 * "published" event came back with onlineStoreUrl null and was invisible on the
 * storefront - correct product, correct variants, nobody could buy it. Found
 * against the real API; the stub had no concept of channels.
 */
async function publishToOnlineStore(shopId, productGid) {
  const pubs = await forShop(shopId, ONLINE_STORE_QUERY, {});
  const onlineStore = (pubs?.publications?.nodes || []).find((n) => n.name === 'Online Store');
  if (!onlineStore) {
    console.warn('No Online Store publication found - the product will not be visible on the storefront.');
    return null;
  }
  const result = await forShop(shopId, PUBLISH_TO_CHANNEL, {
    id: productGid,
    input: [{ publicationId: onlineStore.id }],
  });
  assertNoUserErrors(result?.publishablePublish, 'Putting the event on the Online Store');
  return result.publishablePublish.publishable?.onlineStoreUrl || null;
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

/** Deterministic, so the upsert finds the same product every time. */
function handleFor(event) {
  return `admit-event-${event.id}`;
}

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
    handle: handleFor(event),
    title: event.name,
    descriptionHtml: event.description || '',
    status: status || (event.active === false ? 'DRAFT' : 'ACTIVE'),
    productType: 'Event Ticket',
    // 'event' is what puts the product in the store's Events collection - it is
    // a smart collection with the rule TAG EQUALS "event", so this tag is the
    // membership. 'admit-event' is just so app-made products are easy to pick
    // out in the admin; identity for upserting is the metafield, not a tag.
    tags: ['event', 'admit-event'],
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

  // Without these, the metafields are written but the theme cannot read them,
  // so every event would render with no date and nothing would say why.
  await ensureDefinitions(shopId);

  // Only needed when there is a new variant to seed.
  const needsLocation = ticketTypes.some((t) => t.active !== false && !t.shopify_variant_id && t.capacity != null);
  const locationId = needsLocation ? await primaryLocationId(shopId) : null;

  const input = buildProductInput(event, ticketTypes, { collectionIds, status, locationId });

  let data;
  try {
    data = await forShop(shopId, PUBLISH_MUTATION, {
      input,
      // Prefer the id we already hold; fall back to the deterministic handle.
      identifier: event.shopify_product_id
        ? { id: `gid://shopify/Product/${event.shopify_product_id}` }
        : { handle: handleFor(event) },
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

  // Creating it is not the same as putting it on sale.
  let onlineStoreUrl = product.onlineStoreUrl || null;
  if (!onlineStoreUrl && (status || 'ACTIVE') !== 'DRAFT') {
    try {
      onlineStoreUrl = await publishToOnlineStore(shopId, product.id);
    } catch (error) {
      // The product exists and is correct; it is just not on the storefront
      // yet. Say so rather than failing the whole publish.
      console.error('Could not put the event on the Online Store:', error.message);
      await db.query(
        'UPDATE events SET publish_error = $1 WHERE id = $2 AND shop_id = $3',
        [`Created, but not added to the Online Store: ${error.message}`, eventId, shopId]
      );
    }
  }

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
      onlineStoreUrl,
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
    identifier: event.shopify_product_id
      ? { id: `gid://shopify/Product/${event.shopify_product_id}` }
      : { handle: handleFor(event) },
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
  handleFor,
  unpublishEvent,
  buildProductInput,
  metafieldsFor,
  NAMESPACE,
  OPTION_NAME,
  PUBLISH_MUTATION,
};
