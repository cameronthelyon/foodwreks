// The license model: a free trial, then one payment for lifetime access per
// location. Expired trials lose the public booking page only. Staff keep
// full access to their data and exports, always. Data is never held hostage.

export function licenseState(restaurant, now = Date.now()) {
  const status = restaurant.license_status;
  if (status === 'lifetime' || status === 'comped') return { active: true, kind: status, paidAt: restaurant.license_paid_at };
  if (status === 'suspended') return { active: false, kind: 'suspended' };
  const endsAt = restaurant.trial_ends_at || 0;
  return {
    active: endsAt > now,
    kind: 'trial',
    trialEndsAt: endsAt,
    daysLeft: Math.max(0, Math.ceil((endsAt - now) / 86400000)),
  };
}

export function canTakeOnlineBookings(restaurant, now = Date.now()) {
  return Boolean(restaurant.online_booking) && licenseState(restaurant, now).active;
}

export function activateLifetime(db, restaurantId, ref, now = Date.now()) {
  db.run(
    `UPDATE restaurants SET license_status = 'lifetime', license_paid_at = ?, license_ref = ?, updated_at = ?
      WHERE id = ? AND license_status != 'lifetime'`,
    now,
    ref,
    now,
    restaurantId,
  );
}
