const db = require('./src/config/database');

async function debugWebhookIssue() {
  try {
    console.log('🔍 Debugging webhook cancellation issue...\n');
    
    // 1. Check recent webhook logs
    console.log('1. Recent webhook activity:');
    const webhooks = await db.query(`
      SELECT 
        id, 
        shopify_order_id, 
        webhook_type, 
        processed, 
        error_message, 
        created_at 
      FROM webhook_logs 
      ORDER BY created_at DESC 
      LIMIT 10
    `);
    
    if (webhooks.rows.length === 0) {
      console.log('   ❌ No webhook logs found');
    } else {
      webhooks.rows.forEach(webhook => {
        console.log(`   ${webhook.processed ? '✅' : '❌'} ${webhook.webhook_type} | Order: ${webhook.shopify_order_id} | ${webhook.created_at}`);
        if (webhook.error_message) {
          console.log(`      Error: ${webhook.error_message}`);
        }
      });
    }
    
    // 2. Check tickets by status
    console.log('\n2. Current ticket status distribution:');
    const statusCounts = await db.query(`
      SELECT 
        status, 
        COUNT(*) as count,
        COUNT(*) FILTER (WHERE shopify_order_id IS NOT NULL) as shopify_orders
      FROM tickets 
      GROUP BY status 
      ORDER BY count DESC
    `);
    
    statusCounts.rows.forEach(row => {
      console.log(`   ${row.status}: ${row.count} total (${row.shopify_orders} from Shopify)`);
    });
    
    // 3. Look for potential problematic orders
    console.log('\n3. Recent tickets that might need status updates:');
    const recentTickets = await db.query(`
      SELECT 
        id, 
        shopify_order_id, 
        name, 
        email, 
        status, 
        created_at 
      FROM tickets 
      WHERE shopify_order_id IS NOT NULL 
      AND status = 'valid'
      ORDER BY created_at DESC 
      LIMIT 5
    `);
    
    if (recentTickets.rows.length > 0) {
      recentTickets.rows.forEach(ticket => {
        console.log(`   Ticket ${ticket.id} | Order: ${ticket.shopify_order_id} | Status: ${ticket.status} | ${ticket.name}`);
      });
    } else {
      console.log('   No recent valid tickets from Shopify orders found');
    }
    
    // 4. Check database constraint
    console.log('\n4. Checking database constraint for ticket status:');
    const constraintInfo = await db.query(`
      SELECT 
        tc.constraint_name,
        cc.check_clause
      FROM information_schema.table_constraints tc
      JOIN information_schema.check_constraints cc ON tc.constraint_name = cc.constraint_name
      WHERE tc.table_name = 'tickets' AND tc.constraint_type = 'CHECK'
      AND cc.check_clause LIKE '%status%'
    `);
    
    if (constraintInfo.rows.length > 0) {
      constraintInfo.rows.forEach(constraint => {
        console.log(`   ✅ ${constraint.constraint_name}: ${constraint.check_clause}`);
      });
    } else {
      console.log('   ❌ No status constraint found - this could be the issue!');
    }
    
    console.log('\n📋 Summary & Next Steps:');
    console.log('   1. Check the webhook logs above for processing errors');
    console.log('   2. Verify Shopify webhook URLs are configured correctly:');
    console.log('      - Order cancellations: POST /api/shopify/cancel');
    console.log('      - Order refunds: POST /api/shopify/refund');
    console.log('   3. Check server logs when webhooks are received');
    console.log('   4. Test the debug endpoint: GET /api/shopify/debug/webhooks');
    
    console.log('\n🔧 To manually cancel tickets for testing:');
    console.log('   UPDATE tickets SET status = \'cancelled\' WHERE shopify_order_id = \'<order_id>\';');
    console.log('\n🔧 To manually refund tickets for testing:');
    console.log('   UPDATE tickets SET status = \'refunded\' WHERE shopify_order_id = \'<order_id>\';');
    
  } catch (error) {
    console.error('❌ Debug script error:', error);
  } finally {
    process.exit(0);
  }
}

debugWebhookIssue();