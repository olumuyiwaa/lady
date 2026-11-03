const Queue = require('bull');

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const q = new Queue('test-queue', redisUrl);

async function run() {
  console.log('Starting queue test against', redisUrl);

  // simple processor that resolves after a short delay
  q.process(async (job) => {
    console.log('Processing job', job.id, job.data);
    await new Promise((r) => setTimeout(r, 200));
    return { ok: true };
  });

  const job = await q.add({ hello: 'world' });

  const completed = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Queue test timed out')), 10000);
    q.on('completed', (j, res) => {
      if (j.id === job.id) {
        clearTimeout(timeout);
        resolve(res);
      }
    });
    q.on('failed', (j, err) => {
      if (j.id === job.id) {
        clearTimeout(timeout);
        reject(err);
      }
    });
  });

  console.log('Job completed with result', completed);
  await q.close();
  process.exit(0);
}

run().catch((e) => {
  console.error('Queue test failed', e);
  process.exit(1);
});
