const PRIORITY_EMOJI = {
  urgent: ':rotating_light:',
  high: ':red_circle:',
  medium: ':large_yellow_circle:',
  low: ':large_green_circle:',
};

/**
 * Posts a ticket to the Slack channel via an Incoming Webhook.
 * Throws on failure so the caller can record it.
 */
async function sendTicketToSlack(ticket) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('SLACK_WEBHOOK_URL is not set in .env');

  const priority = ticket.ai_priority || 'medium';
  const title = ticket.ai_title || ticket.title;

  const fields = [
    `*Client:* ${ticket.client}`,
    `*Reported by:* ${ticket.name}`,
    ticket.site_url ? `*Site:* ${ticket.site_url}` : null,
    `*Priority:* ${PRIORITY_EMOJI[priority] || ''} ${priority.toUpperCase()}`,
  ].filter(Boolean);

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🎫 #${ticket.id} — ${title}`.slice(0, 150) },
    },
    { type: 'section', text: { type: 'mrkdwn', text: fields.join('\n') } },
  ];

  if (ticket.ai_ok) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Summary*\n${ticket.ai_summary}`.slice(0, 3000) },
    });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*For devs*\n${ticket.ai_technical}`.slice(0, 3000) },
    });
  } else {
    // AI failed — send the client's own words so the ticket is never lost
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Client's description (AI summary unavailable)*\n${ticket.details}`.slice(0, 3000),
      },
    });
  }

  if (ticket.attachment_url) {
    let link = ticket.attachment_url;
    if (!/^https?:\/\//.test(link)) {
      // Local-disk path like /uploads/xyz.png — needs APP_URL to be clickable
      const base = (process.env.APP_URL || '').replace(/\/$/, '');
      link = base
        ? `${base}${link}`
        : `(attachment saved on server: ${link} — set APP_URL in .env to get clickable links)`;
    }
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Attachment:* ${link}` },
    });
  }

  const submitted = new Date(ticket.created_at).toISOString().replace('T', ' ').slice(0, 16);
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Submitted ${submitted} UTC via ticket form` }],
  });

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `New ticket #${ticket.id}: ${title}`, blocks }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack responded ${res.status}: ${body}`);
  }
}

module.exports = { sendTicketToSlack };
