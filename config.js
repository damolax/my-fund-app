window.MY_FUND_CONFIG = {
  // Route Neon Auth through the current app origin so alternate production hosts work without browser CORS issues.
  neonAuthUrl: `${window.location.origin}/neon-auth`,

  // Route all finance data through the current app origin; the server securely proxies to Neon Data API.
  neonDataApiUrl: `${window.location.origin}/neon-data`,

  adminEmail: 'oyekunleolalekan3168@gmail.com',
  appUrl: `${window.location.origin}/`
};
