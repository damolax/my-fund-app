(() => {
  'use strict'

  const config = window.MY_FUND_CONFIG || {}

  window.MY_FUND_CLOUD_READY = (async () => {
    if (!config.neonAuthUrl || !config.neonDataApiUrl) return null

    const sdk = await import('https://esm.sh/@neondatabase/neon-js@0.7.0-beta?bundle')
    return sdk.createClient({
      auth: {
        adapter: sdk.SupabaseAuthAdapter(),
        url: config.neonAuthUrl,
        allowAnonymous: true,
      },
      dataApi: {
        url: config.neonDataApiUrl,
      },
    })
  })()
})()
