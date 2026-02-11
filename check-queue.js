/**
 * Script untuk cek status Redis Queue Railway
 * Usage: node check-queue.js
 */

require('dotenv').config();
const { Queue } = require('bullmq');
const Redis = require('ioredis');

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: parseInt(process.env.REDIS_PORT),
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: null,
});

const wateringQueue = new Queue('watering', { connection: redis });

async function checkQueue() {
  try {
    console.log('🔍 Checking Railway Queue Status...\n');

    const waiting = await wateringQueue.getWaitingCount();
    const active = await wateringQueue.getActiveCount();
    const completed = await wateringQueue.getCompletedCount();
    const failed = await wateringQueue.getFailedCount();

    console.log('📊 Queue Statistics:');
    console.log(`   ⏳ Waiting: ${waiting}`);
    console.log(`   ⚙️  Active: ${active}`);
    console.log(`   ✅ Completed: ${completed}`);
    console.log(`   ❌ Failed: ${failed}`);

    // Get recent jobs
    console.log('\n📋 Recent Completed Jobs:');
    const completedJobs = await wateringQueue.getCompleted(0, 4);
    
    for (const job of completedJobs) {
      console.log(`\n   Job ID: ${job.id}`);
      console.log(`   Type: ${job.data.type}`);
      console.log(`   Pots: [${job.data.potNumbers.join(', ')}]`);
      console.log(`   Duration: ${job.data.duration}s`);
      console.log(`   Time: ${new Date(job.finishedOn).toLocaleString('id-ID')}`);
    }

    console.log('\n✅ Check complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

checkQueue();
