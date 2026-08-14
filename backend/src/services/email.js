const { Resend } = require('resend');
const db = require('../config/database');
const fs = require('fs');
const path = require('path');

// Check if email is configured
const isEmailConfigured = process.env.RESEND_API_KEY;

// Create Resend client only if API key is configured
let resend = null;
if (isEmailConfigured) {
  resend = new Resend(process.env.RESEND_API_KEY);
}

// Send ticket email with QR code(s)
async function sendTicketEmail({ to, name, eventName, qrCodeDataUrl, verifyUrl, tickets }) {
  // Skip email if not configured
  if (!isEmailConfigured || !resend) {
    console.log('⚠️  Email not configured - skipping email send');
    console.log(`   Ticket would have been sent to: ${to}`);
    return { success: false, message: 'Email not configured' };
  }

  console.log('📧 Resend Email Configuration:');
  console.log('   RESEND_API_KEY:', process.env.RESEND_API_KEY ? `${process.env.RESEND_API_KEY.substring(0, 8)}****` : 'NOT SET');
  console.log('   EMAIL_FROM:', process.env.EMAIL_FROM);
  console.log('   Sending to:', to);

  // Fetch org name and logo from settings
  let orgName = 'Ticket Manager';
  let logoUrl = null;
  let logoBase64 = null;
  try {
    const settingsResult = await db.query('SELECT org_name, logo_url FROM settings LIMIT 1');
    if (settingsResult.rows.length > 0) {
      orgName = settingsResult.rows[0].org_name || orgName;
      logoUrl = settingsResult.rows[0].logo_url;
      
      if (logoUrl) {
        const logoPath = path.join(__dirname, '../..', logoUrl);
        if (fs.existsSync(logoPath)) {
          const logoBuffer = fs.readFileSync(logoPath);
          logoBase64 = logoBuffer.toString('base64');
        }
      }
    }
  } catch (error) {
    console.log('Note: Could not fetch settings, using defaults');
  }

  // Handle consolidated email with multiple tickets
  if (tickets && Array.isArray(tickets) && tickets.length > 0) {
    let ticketsHtml = '';
    const attachments = [];
    
    // Look up event names for all tickets
    const eventIds = [...new Set(tickets.map(t => t.event_id).filter(Boolean))];
    let eventNames = {};
    if (eventIds.length > 0) {
      try {
        const eventsResult = await db.query('SELECT id, name, event_date, location FROM events WHERE id = ANY($1)', [eventIds]);
        eventsResult.rows.forEach(e => { eventNames[e.id] = e; });
      } catch (err) {
        console.log('Note: Could not fetch event names');
      }
    }
    
    tickets.forEach((ticket, index) => {
      const event = eventNames[ticket.event_id] || {};
      const ticketLabel = ticket.event_name || event.name || 'Event Ticket';
      
      // Prepare QR code attachment
      const base64Data = ticket.qrCodeDataUrl.replace(/^data:image\/png;base64,/, '');
      attachments.push({
        filename: `qr-code-${index + 1}.png`,
        content: base64Data,
        content_id: `qrcode${index}`
      });
      
      ticketsHtml += `
        <div style="background: white; padding: 25px; border-radius: 8px; margin-bottom: 25px; border: 2px solid #ddd;">
          <h2 style="color: #4CAF50; margin-top: 0; border-bottom: 2px solid #4CAF50; padding-bottom: 10px;">
            Ticket ${index + 1} of ${tickets.length}: ${ticketLabel}
          </h2>
          ${event.event_date ? `<p style="color: #555;"><strong>Date:</strong> ${new Date(event.event_date).toLocaleDateString()}</p>` : ''}
          ${event.location ? `<p style="color: #555;"><strong>Location:</strong> ${event.location}</p>` : ''}
          <div style="text-align: center; margin: 20px 0;">
            <img src="cid:qrcode${index}" style="max-width: 300px; border: 2px solid #ddd; padding: 10px; background: white;" alt="QR Code ${index + 1}"/>
          </div>
          <p style="text-align: center; color: #666; font-size: 14px; margin-top: 15px;">
            Scan this QR code at the entrance for check-in
          </p>
        </div>
      `;
    });

    // Add logo to attachments if available
    if (logoBase64) {
      attachments.push({
        filename: 'logo.png',
        content: logoBase64,
        content_id: 'logo'
      });
    }

    // Build subject: use event name if all tickets are for the same event
    const uniqueEventNames = [...new Set(tickets.map(t => t.event_name).filter(Boolean))];
    const subjectEventPart = uniqueEventNames.length === 1
      ? ` - ${uniqueEventNames[0]}`
      : '';
    const ticketWord = tickets.length === 1 ? 'Ticket' : 'Tickets';

    return resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: to,
      subject: `Your ${ticketWord}${subjectEventPart} (${tickets.length} ${ticketWord})`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body {
              font-family: Arial, sans-serif;
              line-height: 1.6;
              color: #333;
              background-color: #f4f4f4;
              margin: 0;
              padding: 0;
            }
            .container {
              max-width: 700px;
              margin: 0 auto;
              padding: 20px;
            }
            .header {
              background-color: #4CAF50;
              color: white;
              padding: 30px;
              text-align: center;
              border-radius: 8px 8px 0 0;
            }
            .content {
              padding: 30px;
              background-color: #f9f9f9;
            }
            .footer {
              text-align: center;
              padding: 20px;
              color: #666;
              font-size: 12px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            ${logoBase64 ? `<div style="text-align: center; padding: 20px 0; background-color: white;">
              <img src="cid:logo" alt="${orgName}" style="max-width: 100%; max-height: 150px; object-fit: contain;" />
            </div>` : ''}
            <div class="header">
              <h1 style="margin: 0;">Your Event Tickets</h1>
            </div>
            <div class="content">
              <p>Hello ${name},</p>
              <p>Thank you for your order! Below are your <strong>${tickets.length} ticket(s)</strong>. Each ticket has a unique QR code.</p>
              <p><strong>Important:</strong> Please present each QR code at the entrance for check-in. You can print this email or show it on your phone.</p>
              
              ${ticketsHtml}

              <div style="background: #fff3cd; border: 1px solid #ffc107; padding: 15px; border-radius: 5px; margin-top: 20px;">
                <p style="margin: 0;"><strong>Please Note:</strong></p>
                <ul style="margin: 10px 0;">
                  <li>Each QR code can only be scanned once</li>
                  <li>Keep this email safe - you'll need it at the entrance</li>
                  <li>If you have multiple tickets, present each QR code separately</li>
                </ul>
              </div>
            </div>
            <div class="footer">
              <p>See you at the event!</p>
              <p>If you have any questions, please contact us.</p>
            </div>
          </div>
        </body>
        </html>
      `,
      attachments: attachments
    });
  }

  // Handle single ticket email (manual ticket creation)
  const ticketLabel = eventName || 'Event Ticket';
  
  // Build ticket details HTML
  let detailsHtml = `<p><strong>Name:</strong> ${name}</p>`;
  detailsHtml += `<p><strong>Event:</strong> ${ticketLabel}</p>`;

  // Convert base64 QR code to buffer for attachment
  const base64Data = qrCodeDataUrl.replace(/^data:image\/png;base64,/, '');

  // Prepare attachments
  const singleTicketAttachments = [
    {
      filename: 'qrcode.png',
      content: base64Data,
      content_id: 'qrcode'
    }
  ];

  // Add logo if available
  if (logoBase64) {
    singleTicketAttachments.push({
      filename: 'logo.png',
      content: logoBase64,
      content_id: 'logo'
    });
  }

  return resend.emails.send({
    from: process.env.EMAIL_FROM,
    to: to,
    subject: `Your Ticket - ${ticketLabel}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #4CAF50; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background-color: #f9f9f9; }
          .qr-code { text-align: center; margin: 30px 0; }
          .qr-code img { max-width: 300px; border: 2px solid #ddd; padding: 10px; background: white; }
          .footer { text-align: center; padding: 20px; font-size: 12px; color: #666; }
          .button { display: inline-block; padding: 12px 30px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          ${logoBase64 ? `<div style="text-align: center; padding: 20px 0; background-color: white;">
            <img src="cid:logo" alt="${orgName}" style="max-width: 100%; max-height: 150px; object-fit: contain;" />
          </div>` : ''}
          <div class="header">
            <h1>${ticketLabel}</h1>
          </div>
          <div class="content">
            <h2>Hello ${name}!</h2>
            <p>Your event ticket has been issued.</p>
            ${detailsHtml}
            
            <div class="qr-code">
              <p><strong>Your Ticket QR Code:</strong></p>
              <img src="cid:qrcode" alt="Ticket QR Code" />
              <div style="background: #4CAF50; color: white; padding: 12px 20px; border-radius: 6px; display: inline-block; margin-top: 15px; font-weight: bold; font-size: 16px;">
                ${ticketLabel}
              </div>
              <p>Scan this QR code at the event entrance</p>
            </div>
            
            <p style="text-align: center;">
              <a href="${verifyUrl}" class="button">View Ticket Online</a>
            </p>
            
            <p><strong>Important:</strong> This ticket can only be used once. Please keep it safe and present it at the event entrance.</p>
          </div>
          <div class="footer">
            <p>This is an automated email. Please do not reply.</p>
          </div>
        </div>
      </body>
      </html>
    `,
    attachments: singleTicketAttachments
  });
}

// Send admin notification email
async function sendAdminNotification({ subject, message, ticketDetails }) {
  // Skip if email not configured or admin email not set
  if (!isEmailConfigured || !resend || !process.env.ADMIN_EMAIL) {
    console.log('⚠️  Admin notification skipped - email or admin email not configured');
    return { success: false, message: 'Email not configured' };
  }

  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: process.env.ADMIN_EMAIL,
      subject: `[Admin Alert] ${subject}`,
      html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .header {
            background-color: #f44336;
            color: white;
            padding: 20px;
            text-align: center;
          }
          .content {
            padding: 20px;
            background-color: #fff3e0;
            border: 1px solid #ffcc80;
          }
          .details {
            background: white;
            padding: 15px;
            margin: 15px 0;
            border-radius: 5px;
            border: 1px solid #ddd;
          }
          .details p {
            margin: 5px 0;
          }
          .footer {
            text-align: center;
            padding: 20px;
            font-size: 12px;
            color: #666;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>⚠️ Admin Alert</h1>
          </div>
          <div class="content">
            <h2>${subject}</h2>
            <p>${message}</p>
            
            ${ticketDetails ? `
              <div class="details">
                <h3>Ticket Details:</h3>
                ${ticketDetails.recipientEmail ? `<p><strong>Recipient Email:</strong> ${ticketDetails.recipientEmail}</p>` : ''}
                ${ticketDetails.recipientName ? `<p><strong>Recipient Name:</strong> ${ticketDetails.recipientName}</p>` : ''}
                ${ticketDetails.ticketType ? `<p><strong>Ticket Type:</strong> ${ticketDetails.ticketType}</p>` : ''}
                ${ticketDetails.ticketId ? `<p><strong>Ticket ID:</strong> ${ticketDetails.ticketId}</p>` : ''}
                ${ticketDetails.error ? `<p><strong>Error:</strong> <code>${ticketDetails.error}</code></p>` : ''}
              </div>
            ` : ''}
            
            <p><strong>Action Required:</strong> Please review this issue and take appropriate action.</p>
          </div>
          <div class="footer">
            <p>This is an automated admin notification from your Event Ticket Manager.</p>
          </div>
        </div>
      </body>
      </html>
    `,
    });
    console.log(`✓ Admin notification sent to ${process.env.ADMIN_EMAIL}`);
    return { success: true };
  } catch (error) {
    console.error('Failed to send admin notification:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  sendTicketEmail,
  sendAdminNotification,
};
