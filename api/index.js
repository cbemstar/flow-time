/* Vercel serverless entry — every /api, /oauth and /calendar.ics request
   is routed here by vercel.json. Static files are served from public/ by
   the CDN and never reach this function. */
export { default } from '../lib/app.js';
