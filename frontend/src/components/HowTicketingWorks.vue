<template>
  <div class="how-it-works">
    <div class="how-head">
      <h3>How ticketing works</h3>
      <button v-if="dismissible" type="button" class="how-close" @click="$emit('close')">Close</button>
    </div>

    <p class="how-lede">
      <strong>An event lives only in this app.</strong> Shopify has no idea it exists — Shopify
      sells <em>products</em>, this app issues <em>tickets</em>. The one thing joining them is a
      ticket type pointing at a Shopify variant. Nothing here creates a product for you, and
      nothing in Shopify creates an event.
    </p>

    <ol class="how-steps">
      <li>
        <h4>Make the product in Shopify</h4>
        <p>
          One product per show. One <strong>variant per kind of ticket</strong> — VIP, Adult,
          Child, Saturday-only. Selling one kind of ticket? One variant is all you need.
          Set the variant's inventory there if you want Shopify to stop the sale when you sell out.
        </p>
      </li>
      <li>
        <h4>Create the event here</h4>
        <p>
          Name, when it starts, and where. If it runs across more than one day — a weekend pass —
          tick <em>Runs until a later date or time</em> and give it an end. It stays one event,
          with one set of numbers.
        </p>
      </li>
      <li>
        <h4>Point each ticket type at its variant</h4>
        <p>
          This is the actual hook-up, and the step that is easy to skip.
          <template v-if="embedded">
            Use <strong>Pick in Shopify</strong> on the ticket type row and choose the variant —
            no copying IDs.
          </template>
          <template v-else>
            Paste the variant ID from the Shopify admin (it is the number at the end of the
            product URL when a variant is selected), or the SKU.
          </template>
          Orders match on <strong>variant ID first</strong>, then SKU — a variant ID never changes,
          but a SKU is free text somebody can tidy up in Shopify without realising it breaks this.
        </p>
      </li>
      <li>
        <h4>Someone buys a ticket</h4>
        <p>
          Shopify sends the order here, the app matches each line item to a ticket type, issues one
          ticket per unit, and emails the QR codes. Refunds and cancellations void the matching
          tickets automatically.
        </p>
      </li>
    </ol>

    <div class="how-callout">
      <h4>When a ticket does not turn up</h4>
      <p>
        Almost always the mapping. A ticket type with nothing in it is marked
        <span class="how-chip">not mapped</span> on the event card — orders can never match it.
        If a line item matched nothing, the order shows up under
        <strong>Webhooks → Needs attention</strong> with the SKU that missed, and you can map it and
        retry the order without asking the customer to do anything.
      </p>
    </div>

    <p class="how-footnote">
      Archiving an event hides it and <strong>stops its tickets scanning</strong> — do it after the
      show, not before. Deactivating a ticket type stops new sales matching it but leaves tickets
      already issued working.
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
    // The instructions differ: the variant picker only exists inside the
    // Shopify admin, so telling a standalone user to click it would be wrong.
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
</style>
