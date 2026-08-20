/**
 * The metafield definitions the storefront needs.
 *
 * Without a definition carrying storefront access, a metafield written onto a
 * product is invisible to theme Liquid - so the events section would render
 * every event with no date and no location, and nothing would say why. The
 * definitions are what make `product.metafields.admit.starts_at` readable.
 *
 * Run once per shop, on first publish. metafieldDefinitionCreate returns a
 * TAKEN error when the definition already exists, which is success as far as we
 * are concerned.
 */

const { forShop } = require('./admin-api');

const NAMESPACE = 'admit';

const DEFINITIONS = [
  {
    key: 'event_id', name: 'Admit event ID', ownerType: 'PRODUCT',
    type: 'single_line_text_field',
    description: 'Which event in the ticketing app this product sells tickets for.',
  },
  {
    key: 'starts_at', name: 'Event starts', ownerType: 'PRODUCT', type: 'date_time',
    description: 'When the event begins. Shown on the events page.', pin: true,
  },
  {
    key: 'ends_at', name: 'Event ends', ownerType: 'PRODUCT', type: 'date_time',
    description: 'When the event finishes. Blank for a single-session event.', pin: true,
  },
  {
    key: 'location', name: 'Event location', ownerType: 'PRODUCT',
    type: 'single_line_text_field',
    description: 'Where the event is held. Shown on the events page.', pin: true,
  },
  {
    key: 'ticket_type_id', name: 'Admit ticket type ID', ownerType: 'PRODUCTVARIANT',
    type: 'single_line_text_field',
    description: 'Which ticket type in the ticketing app this variant sells.',
  },
];

const CREATE = `
  mutation AdmitDefineMetafield($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id key }
      userErrors { field message code }
    }
  }
`;

async function ensureDefinitions(shopId) {
  const created = [];
  for (const def of DEFINITIONS) {
    try {
      const data = await forShop(shopId, CREATE, {
        definition: {
          namespace: NAMESPACE,
          key: def.key,
          name: def.name,
          description: def.description,
          ownerType: def.ownerType,
          type: def.type,
          access: { storefront: 'PUBLIC_READ' },
          ...(def.pin ? { pin: true } : {}),
        },
      });
      const errors = data?.metafieldDefinitionCreate?.userErrors || [];
      // Already there: fine, and the common case after the first publish.
      const taken = errors.some((e) => e.code === 'TAKEN' || /taken|already/i.test(e.message || ''));
      if (errors.length > 0 && !taken) {
        console.warn(`Could not define ${NAMESPACE}.${def.key}:`, JSON.stringify(errors));
      } else if (errors.length === 0) {
        created.push(def.key);
      }
    } catch (error) {
      // Never block a publish on this: the product is still correct, the
      // storefront just will not show the date until the definition exists.
      console.warn(`Could not define ${NAMESPACE}.${def.key}:`, error.message);
    }
  }
  if (created.length > 0) {
    console.log(`Created metafield definitions: ${created.join(', ')}`);
  }
  return created;
}

module.exports = { ensureDefinitions, DEFINITIONS, NAMESPACE };
