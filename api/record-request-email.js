const DATA_API_URL = 'https://ep-cool-lake-b5w5dfc2.apirest.c-7.us-east-2.aws.neon.tech/my_fund_app/rest/v1'

async function rpc(name, payload, authorization) {
  const response = await fetch(`${DATA_API_URL}/rpc/${name}`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const text = await response.text()
  let body = null
  if (text) {
    try { body = JSON.parse(text) } catch { body = text }
  }

  if (!response.ok) {
    const message =
      (body && typeof body === 'object' && (body.message || body.details || body.hint)) ||
      (typeof body === 'string' && body) ||
      `Neon request failed with status ${response.status}`
    throw new Error(message)
  }

  return body
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const requestId = String(req.body?.request_id || '').trim()
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) {
    return res.status(400).json({ error: 'A valid request_id is required' })
  }

  const authorization = String(req.headers.authorization || '')
  if (!authorization.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' })
  }

  const apiKey = process.env.RESEND_API_KEY
  const fromEmail = process.env.MY_FUND_FROM_EMAIL
  if (!apiKey || !fromEmail) {
    return res.status(202).json({
      queued: true,
      emailConfigured: false,
      message: 'The in-app notification is active. Email remains queued until the mail provider is configured.',
    })
  }

  let claimed
  try {
    claimed = await rpc('mfa_claim_request_email', { p_request_id: requestId }, authorization)
  } catch (error) {
    return res.status(403).json({ error: error.message || 'Unable to claim approval email' })
  }

  if (!claimed || claimed.status === 'none') {
    return res.status(200).json({ queued: false, status: 'none' })
  }
  if (claimed.status === 'sent' || claimed.status === 'busy') {
    return res.status(200).json({ queued: true, status: claimed.status })
  }
  if (claimed.status !== 'ready' || !claimed.outbox_id) {
    return res.status(200).json({ queued: true, status: claimed.status || 'pending' })
  }

  let success = false
  let deliveryError = ''
  let providerId = null

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [claimed.recipient_email],
        subject: claimed.subject,
        html: claimed.html_body,
      }),
    })

    const text = await response.text()
    let body = null
    if (text) {
      try { body = JSON.parse(text) } catch { body = text }
    }

    if (!response.ok) {
      deliveryError =
        (body && typeof body === 'object' && (body.message || body.error)) ||
        (typeof body === 'string' && body) ||
        `Email provider returned status ${response.status}`
    } else {
      success = true
      providerId = body?.id || null
    }
  } catch (error) {
    deliveryError = error.message || 'Email delivery failed'
  }

  try {
    await rpc(
      'mfa_complete_request_email',
      {
        p_outbox_id: claimed.outbox_id,
        p_success: success,
        p_error: success ? null : deliveryError,
      },
      authorization,
    )
  } catch (error) {
    if (success) {
      return res.status(200).json({
        sent: true,
        providerId,
        warning: 'Email sent, but the outbox status could not be updated.',
      })
    }
  }

  if (!success) {
    return res.status(502).json({ sent: false, error: deliveryError })
  }

  return res.status(200).json({ sent: true, providerId })
}
