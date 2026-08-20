<template>
  <div class="how-it-works">
    <div class="how-head">
      <h3>How ticketing works</h3>
      <button v-if="dismissible" type="button" class="how-close" @click="$emit('close')">Close</button>
    </div>

    <p class="how-lede">
      <strong>An event lives here; Shopify sells it.</strong> Shopify has no concept of an event —
      it sells <em>products</em>, and this app issues <em>tickets</em>. Publishing an event creates
      its Shopify product for you: <strong>one product per event, one variant per ticket type</strong>.
      You do not make the product by hand.
    </p>

    <ol class="how-steps">
      <li>
        <h4>Create the event</h4>
        <p>
          Name, when it starts, and where. If it runs across more than one day — a weekend pass —
          tick <em>Runs until a later date or time</em> and give it an end. It stays one event, with
          one set of numbers.
        </p>
      </li>
      <li>
        <h4>Add a ticket type for each thing you sell</h4>
        <p>
          VIP, Adult, Child, Saturday-only — each with a price. Selling one kind of ticket? One type
          is all you need, and you can ignore the idea entirely. Capacity is optional and is enforced
          <em>here</em>, not in Shopify.
        </p>
      </li>
      <li>
        <h4>Press Publish</h4>
        <p>
          The app creates the Shopify product and one variant per ticket type, and writes the date
          and location alongside it so a storefront events page can show them. Publish again after
          any change — it updates the same product rather than making a second one, and renaming a
          ticket type edits its variant rather than replacing it, so tickets already sold keep
          working.
        </p>
      </li>
      <li>
        <h4>Someone buys a ticket</h4>
        <p>
          Shopify sends the order here, the app matches each line item back to its ticket type,
          issues one ticket per unit, and emails the QR codes. Refunds and cancellations void the
          matching tickets automatically.
        </p>
      </li>
    </ol>

    <p class="how-storefront">
      To show these on your site, add the <strong>Events list</strong> block to a page in the theme
      editor (Apps → Admit events) and point it at the collection holding your event products.
    </p>

    <div class="how-callout">
      <h4>When a ticket does not turn up</h4>
      <p>
        Usually the event was never published, or was changed after publishing and not published
        again — a ticket type with no variant behind it is marked
        <span class="how-chip">not mapped</span> on the event card, and orders can never match it.
        If a line item matched nothing, the order shows up under
        <strong>Webhooks → Needs attention</strong> with the SKU that missed, and you can fix the
        mapping and retry the order without asking the customer to do anything.
      </p>
    </div>

    <p class="how-footnote">
      Archiving an event hides it and <strong>stops its tickets scanning</strong> — do it after the
      show, not before. Taking an event off the storefront only sets its product back to draft;
      nothing is deleted and tickets already sold are unaffected.
    </p>
  </div>
</template>

<script>
import { isEmbedded } from '@/shopify';

export default {
  name: 'HowTicketingWorks',
  props: {
    dismissible: { type: Boolean, default: false },
  },
  emits: ['close'],
  setup() {
    // Kept for the picker hint elsewhere in the form: it only exists inside
    // the Shopify admin, so telling a standalone user to click it would be wrong.
    return { embedded: isEmbedded() };
  },
};
</script>

<style scoped>
.how-it-works {
  background: white;
  border: 1px solid #e3e6f5;
  border-left: 5px solid #667eea;
  border-radius: 12px;
  padding: 24px 28px;
  margin-bottom: 20px;
  max-width: 900px;
}

.how-head { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.how-head h3 { margin: 0; font-size: 19px; color: #333; }
.how-close {
  border: 1px solid #ddd; background: white; border-radius: 6px;
  padding: 6px 14px; font-size: 13px; cursor: pointer; color: #555;
}
.how-close:hover { background: #f5f5f5; }

.how-lede { margin: 10px 0 18px; color: #444; font-size: 14px; line-height: 1.6; }

.how-steps { margin: 0; padding-left: 22px; }
.how-steps li { margin-bottom: 16px; }
.how-steps h4 { margin: 0 0 4px; font-size: 14px; color: #3f4a8a; }
.how-steps p { margin: 0; font-size: 14px; color: #555; line-height: 1.6; }

.how-callout {
  background: #fffaf2;
  border: 1px solid #ffd9a0;
  border-radius: 8px;
  padding: 14px 18px;
  margin: 18px 0 14px;
}
.how-callout h4 { margin: 0 0 4px; font-size: 14px; color: #8a5a00; }
.how-callout p { margin: 0; font-size: 14px; color: #6b5330; line-height: 1.6; }
.how-chip {
  background: #fff6e5; border: 1px solid #ffe0a3; color: #8a5a00;
  padding: 1px 8px; border-radius: 10px; font-size: 12px; font-weight: 600;
}

.how-footnote { margin: 0; font-size: 13px; color: #777; line-height: 1.6; }
.how-storefront { margin: 14px 0 0; font-size: 14px; color: #3f4a8a; line-height: 1.6; }
</style>
