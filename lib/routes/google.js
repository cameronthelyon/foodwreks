// Google Actions Center booking server (v3) and feeds. Mounted at /google,
// so the base URL registered in Google's Partner Portal is {BASE_URL}/google.

import {
  availabilityFeed,
  batchAvailabilityLookup,
  createBooking,
  getBookingStatus,
  googleAuthorized,
  healthCheck,
  listBookings,
  merchantFeed,
  serviceFeed,
  updateBooking,
} from '../google.js';
import { HttpError } from '../http.js';

export function registerGoogle(router, app) {
  const guard = (ctx) => {
    if (!googleAuthorized(ctx.req, app.config)) {
      ctx.res.setHeader('WWW-Authenticate', 'Basic realm="booking"');
      throw new HttpError(401, 'unauthorized', 'Unauthorized.');
    }
  };
  const body = (ctx) => ctx.body ?? JSON.parse(ctx.rawBody.toString('utf8') || '{}');

  router.get('/google/v3/HealthCheck', guard, () => healthCheck());
  router.post('/google/v3/BatchAvailabilityLookup', guard, (ctx) => batchAvailabilityLookup(app, body(ctx)));
  router.post('/google/v3/CreateBooking', guard, (ctx) => createBooking(app, body(ctx)));
  router.post('/google/v3/UpdateBooking', guard, (ctx) => updateBooking(app, body(ctx)));
  router.post('/google/v3/GetBookingStatus', guard, (ctx) => getBookingStatus(app, body(ctx)));
  router.post('/google/v3/ListBookings', guard, (ctx) => listBookings(app, body(ctx)));

  router.get('/google/feeds/merchants.json', guard, () => merchantFeed(app));
  router.get('/google/feeds/services.json', guard, () => serviceFeed(app));
  router.get('/google/feeds/availability.json', guard, () => availabilityFeed(app));
}
