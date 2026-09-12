/**
 * Signature table for deterministic technology-stack fingerprinting
 * (decision D3, `docs/analysis/wave-6-audit-pipeline.md`): no vendor, no new
 * dependency — every signature matches against data `fetcher` already
 * retrieves (response headers, raw HTML, script `src` attributes, inline
 * script text, `<meta name="generator">`).
 *
 * Deliberately NOT covered here (see `LEFT-OUT.md`): cookie-based signatures
 * (fetcher does not parse `set-cookie`) and anything only visible after
 * client-side JS runs (would need a Playwright render, which D3 rules out).
 *
 * @module tech-stack.signatures
 */

export type TechCategory =
  | 'analytics'
  | 'ads'
  | 'crm'
  | 'chat'
  | 'cms'
  | 'hosting'
  | 'cdn'
  | 'ecommerce'
  | 'tag-manager'
  | 'ab-testing';

/**
 * One detectable technology. A signature matches when ANY of its defined
 * fields matches its corresponding signal — `headers` is tested against every
 * header value (not just one named key), the rest against the named extracted
 * string.
 */
export interface TechSignature {
  category: TechCategory;
  name: string;
  headers?: RegExp[];
  html?: RegExp;
  scriptSrc?: RegExp;
  generator?: RegExp;
}

export const TECH_SIGNATURES: TechSignature[] = [
  // ─── Analytics ────────────────────────────────────────────────
  { category: 'analytics', name: 'Google Analytics (GA4)', scriptSrc: /gtag\/js\?id=G-/i, html: /gtag\(['"]config['"],\s*['"]G-/i },
  { category: 'analytics', name: 'Google Analytics (Universal)', scriptSrc: /google-analytics\.com\/analytics\.js/i, html: /\bga\(['"]create['"]/i },
  { category: 'analytics', name: 'Google Tag Manager', scriptSrc: /googletagmanager\.com\/gtm\.js/i, html: /GTM-[A-Z0-9]+/ },
  { category: 'analytics', name: 'Meta Pixel', scriptSrc: /connect\.facebook\.net\/.*\/fbevents\.js/i, html: /\bfbq\(['"]init['"]/i },
  { category: 'analytics', name: 'Hotjar', scriptSrc: /static\.hotjar\.com/i, html: /hjid\s*:/i },
  { category: 'analytics', name: 'Microsoft Clarity', scriptSrc: /clarity\.ms\/tag/i },
  { category: 'analytics', name: 'Mixpanel', scriptSrc: /cdn\.mxpnl\.com/i, html: /mixpanel\.init\(/i },
  { category: 'analytics', name: 'Segment', scriptSrc: /cdn\.segment\.com\/analytics\.js/i },
  { category: 'analytics', name: 'Amplitude', scriptSrc: /cdn\.amplitude\.com/i },
  { category: 'analytics', name: 'Plausible', scriptSrc: /plausible\.io\/js\/(script|plausible)/i },
  { category: 'analytics', name: 'Matomo', scriptSrc: /matomo\.js|piwik\.js/i },
  { category: 'analytics', name: 'Heap', scriptSrc: /cdn\.heapanalytics\.com/i },

  // ─── Ads / tracking ─────────────────────────────────────────────
  { category: 'ads', name: 'Google Ads Conversion Tracking', html: /AW-\d{9,}/ },
  { category: 'ads', name: 'LinkedIn Insight Tag', scriptSrc: /snap\.licdn\.com\/li\.lms-analytics/i },
  { category: 'ads', name: 'TikTok Pixel', scriptSrc: /analytics\.tiktok\.com/i, html: /ttq\.load\(/i },
  { category: 'ads', name: 'Twitter/X Pixel', scriptSrc: /static\.ads-twitter\.com/i },
  { category: 'ads', name: 'Pinterest Tag', scriptSrc: /s\.pinimg\.com\/ct\/core\.js/i },
  { category: 'ads', name: 'Snapchat Pixel', scriptSrc: /sc-static\.net\/scevent\.min\.js/i },
  { category: 'ads', name: 'Reddit Pixel', scriptSrc: /www\.redditstatic\.com\/ads\/pixel\.js/i },
  { category: 'ads', name: 'Criteo', scriptSrc: /static\.criteo\.net/i },
  { category: 'ads', name: 'Taboola', scriptSrc: /cdn\.taboola\.com/i },
  { category: 'ads', name: 'Outbrain', scriptSrc: /widgets\.outbrain\.com/i },

  // ─── CRM / lead capture ───────────────────────────────────────
  { category: 'crm', name: 'HubSpot', scriptSrc: /js\.hs-scripts\.com|js\.hsforms\.net|js\.hubspot\.com/i, generator: /HubSpot/i },
  { category: 'crm', name: 'Salesforce (Pardot/Marketing Cloud)', scriptSrc: /pi\.pardot\.com|cl\d+\.salesforce\.com/i },
  { category: 'crm', name: 'Marketo', scriptSrc: /munchkin\.js|marketo\.net/i },
  { category: 'crm', name: 'ActiveCampaign', scriptSrc: /activehosted\.com\/f\/embed\.php/i },
  { category: 'crm', name: 'Mailchimp', scriptSrc: /chimpstatic\.com\/mcjs-connected/i },
  { category: 'crm', name: 'Klaviyo', scriptSrc: /static\.klaviyo\.com/i },
  { category: 'crm', name: 'Zoho CRM', scriptSrc: /webforms\.zohopublic\.com|zoho\.com\/crm/i },
  { category: 'crm', name: 'Pipedrive', scriptSrc: /leadbooster-chat\.pipedrive\.com/i },

  // ─── Chat / conversion widgets ──────────────────────────────────
  { category: 'chat', name: 'Intercom', scriptSrc: /widget\.intercom\.io/i, html: /Intercom\(['"]boot['"]/i },
  { category: 'chat', name: 'Drift', scriptSrc: /js\.driftt\.com/i },
  { category: 'chat', name: 'Zendesk Chat', scriptSrc: /static\.zdassets\.com|v2\.zopim\.com/i },
  { category: 'chat', name: 'Crisp', scriptSrc: /client\.crisp\.chat/i },
  { category: 'chat', name: 'Tawk.to', scriptSrc: /embed\.tawk\.to/i },
  { category: 'chat', name: 'LiveChat', scriptSrc: /cdn\.livechatinc\.com/i },
  { category: 'chat', name: 'Tidio', scriptSrc: /code\.tidio\.co/i },
  { category: 'chat', name: 'Freshchat', scriptSrc: /wchat\.freshchat\.com/i },

  // ─── CMS ────────────────────────────────────────────────────────
  { category: 'cms', name: 'WordPress', generator: /WordPress/i, html: /wp-content\/|wp-includes\//i },
  { category: 'cms', name: 'Wix', generator: /Wix\.com/i, html: /static\.wixstatic\.com/i },
  { category: 'cms', name: 'Squarespace', generator: /Squarespace/i, html: /static1\.squarespace\.com/i },
  { category: 'cms', name: 'Webflow', generator: /Webflow/i, html: /assets-global\.website-files\.com/i },
  { category: 'cms', name: 'Drupal', generator: /Drupal/i, html: /\/sites\/default\/files\//i },
  { category: 'cms', name: 'Joomla', generator: /Joomla/i },
  { category: 'cms', name: 'Ghost', generator: /Ghost/i, html: /ghost\.io|\/ghost\/api\//i },
  { category: 'cms', name: 'Contentful', html: /images\.ctfassets\.net/i },
  { category: 'cms', name: 'Sanity', html: /cdn\.sanity\.io/i },
  { category: 'cms', name: 'Framer', generator: /Framer/i, html: /framerusercontent\.com/i },
  { category: 'cms', name: 'HubSpot CMS', generator: /HubSpot/i, html: /hs-sites\.com|hubspotusercontent/i },

  // ─── Hosting / CDN (response headers) ─────────────────────────
  { category: 'cdn', name: 'Cloudflare', headers: [/^cloudflare$/i] },
  { category: 'cdn', name: 'Fastly', headers: [/^fastly$/i] },
  { category: 'cdn', name: 'Akamai', headers: [/^akamaighost$/i, /akamai/i] },
  { category: 'cdn', name: 'Amazon CloudFront', headers: [/cloudfront/i] },
  { category: 'cdn', name: 'Google Cloud CDN', headers: [/^gws$/i, /googleusercontent/i] },
  { category: 'cdn', name: 'BunnyCDN', headers: [/^bunnycdn/i] },
  { category: 'cdn', name: 'KeyCDN', headers: [/^keycdn/i] },
  { category: 'hosting', name: 'Vercel', headers: [/^vercel$/i] },
  { category: 'hosting', name: 'Netlify', headers: [/^netlify$/i] },
  { category: 'hosting', name: 'GitHub Pages', headers: [/^github\.com$/i] },
  { category: 'hosting', name: 'Heroku', headers: [/^cowboy$/i, /herokuapp/i] },
  { category: 'hosting', name: 'AWS (Amazon S3/EC2 origin)', headers: [/^amazons3$/i, /^awselb\//i] },
  { category: 'hosting', name: 'Shopify (platform)', headers: [/^shopify$/i] },
  { category: 'hosting', name: 'Squarespace (platform)', headers: [/^squarespace$/i] },
  { category: 'hosting', name: 'WP Engine', headers: [/^wpengine/i] },
  { category: 'hosting', name: 'Kinsta', headers: [/^kinsta/i] },

  // ─── Ecommerce ────────────────────────────────────────────────
  { category: 'ecommerce', name: 'Shopify', generator: /Shopify/i, html: /cdn\.shopify\.com/i, headers: [/^shopify$/i] },
  { category: 'ecommerce', name: 'WooCommerce', html: /woocommerce/i },
  { category: 'ecommerce', name: 'BigCommerce', html: /cdn\d*\.bigcommerce\.com/i, generator: /BigCommerce/i },
  { category: 'ecommerce', name: 'Magento', html: /\/skin\/frontend\/|Mage\.Cookies/i, generator: /Magento/i },
  { category: 'ecommerce', name: 'Wix eCommerce', html: /wixapps\.net\/html-store/i },
  { category: 'ecommerce', name: 'Squarespace Commerce', html: /squarespace-commerce/i },
  { category: 'ecommerce', name: 'PrestaShop', generator: /PrestaShop/i },

  // ─── Tag managers (distinct from GTM, already under analytics) ─
  { category: 'tag-manager', name: 'Tealium', scriptSrc: /tags\.tiqcdn\.com/i },
  { category: 'tag-manager', name: 'Adobe Launch / DTM', scriptSrc: /assets\.adobedtm\.com/i },
  { category: 'tag-manager', name: 'Ensighten', scriptSrc: /nexus\.ensighten\.com/i },

  // ─── A/B testing ────────────────────────────────────────────────
  { category: 'ab-testing', name: 'Optimizely', scriptSrc: /cdn\.optimizely\.com/i },
  { category: 'ab-testing', name: 'VWO', scriptSrc: /dev\.visualwebsiteoptimizer\.com/i },
  { category: 'ab-testing', name: 'Google Optimize', scriptSrc: /googleoptimize\.com\/optimize\.js/i },
  { category: 'ab-testing', name: 'AB Tasty', scriptSrc: /try\.abtasty\.com/i },
  { category: 'ab-testing', name: 'Split.io', scriptSrc: /cdn\.split\.io/i },
];
