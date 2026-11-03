/** Haversine distance in meters between two lat/lng points. */
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** True if (lat, lng) falls inside any of the given ServiceArea records. */
function isWithinServiceAreas(lat, lng, serviceAreas) {
  return serviceAreas.some(
    (area) => distanceMeters(lat, lng, area.centerLat, area.centerLng) <= area.radiusMeters
  );
}

module.exports = { distanceMeters, isWithinServiceAreas };
