const { Client } = require('@googlemaps/google-maps-services-js');

const client = new Client({});

async function distanceAndDuration(origin, destination) {
  // origin/destination: { lat, lng }
  const key = process.env.GOOGLE_DISTANCE_MATRIX_API_KEY;
  if (!key) return null;
  try {
    const resp = await client.distancematrix({ params: { origins: [`${origin.lat},${origin.lng}`], destinations: [`${destination.lat},${destination.lng}`], key } });
    const row = resp.data.rows && resp.data.rows[0];
    const elem = row && row.elements && row.elements[0];
    if (!elem || elem.status !== 'OK') return null;
    return { distanceMeters: elem.distance.value, durationSeconds: elem.duration.value };
  } catch (e) {
    return null;
  }
}

module.exports = { distanceAndDuration };
