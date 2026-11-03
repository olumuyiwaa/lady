const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const BUCKET = process.env.DO_SPACES_BUCKET;

const spaces = new S3Client({
  endpoint: process.env.DO_SPACES_ENDPOINT,
  region: process.env.DO_SPACES_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.DO_SPACES_KEY || '',
    secretAccessKey: process.env.DO_SPACES_SECRET || '',
  },
  forcePathStyle: true,
});

async function getSignedUploadUrl(key, contentType, expiresSeconds = 300) {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
    ACL: 'private',
  });
  return getSignedUrl(spaces, command, { expiresIn: expiresSeconds });
}

async function getSignedDownloadUrl(key, expiresSeconds = 300) {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
  });
  return getSignedUrl(spaces, command, { expiresIn: expiresSeconds });
}

async function deleteObject(key) {
  return spaces.send(
    new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: key,
    })
  );
}

// Public marketing assets (logo, site hero image, gallery photos) need a
// URL that keeps working indefinitely and can be cached by browsers/CDNs —
// a signed getSignedDownloadUrl expires in minutes, which is fine for a
// private cleaner document but would make a business's own logo go blank
// on their public site shortly after the page loads. These two exist so
// branding assets are uploaded as public-read and referenced by a
// permanent URL instead, while private documents keep using the signed
// helpers above unchanged.
function getPublicUrl(key) {
  if (!key) return null;
  if (process.env.DO_SPACES_CDN_ENDPOINT) {
    return `${process.env.DO_SPACES_CDN_ENDPOINT.replace(/\/$/, '')}/${key}`;
  }
  // DigitalOcean Spaces public URL convention: bucket as a subdomain of
  // the region endpoint, e.g. https://my-bucket.nyc3.digitaloceanspaces.com/key
  const endpoint = (process.env.DO_SPACES_ENDPOINT || '').replace(/^https?:\/\//, '');
  return `https://${BUCKET}.${endpoint}/${key}`;
}

async function getPublicUploadUrl(key, contentType, expiresSeconds = 300) {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
    ACL: 'public-read',
  });
  return getSignedUrl(spaces, command, { expiresIn: expiresSeconds });
}

module.exports = { spaces, BUCKET, getSignedUploadUrl, getSignedDownloadUrl, deleteObject, getPublicUrl, getPublicUploadUrl };
