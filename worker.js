/**
 * ApsGo Railway Worker
 * Background service untuk automation scheduling 24/7
 * Features:
 * - Waktu Mode: Scheduled watering by time
 * - Sensor Mode: Automatic watering by soil moisture threshold
 * - Redis Queue: Prevent race conditions & concurrent task management
 * - Firebase Realtime DB: Sync dengan Flutter app dan ESP32
 */

require('dotenv').config();
const admin = require('firebase-admin');
const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const cron = require('cron');

// ==================== CONFIGURATION ====================

const config = {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null, // Required for BullMQ
  },
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  },
  worker: {
    concurrency: 1, // Process 1 job at a time (prevent race condition)
    checkInterval: 30000, // Check jadwal setiap 30 detik
    sensorDebounce: 120000, // 2 menit minimum antar penyiraman per pot
  },
};

console.log('🚀 Starting ApsGo Railway Worker...');
console.log(`📡 Firebase Project: ${config.firebase.projectId}`);
console.log(`📦 Redis: ${config.redis.host}:${config.redis.port}`);

// ==================== FIREBASE INITIALIZATION ====================

try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: config.firebase.projectId,
      clientEmail: config.firebase.clientEmail,
      privateKey: config.firebase.privateKey,
    }),
    databaseURL: config.firebase.databaseURL,
  });
  console.log('✅ Firebase Admin initialized');
} catch (error) {
  console.error('❌ Firebase initialization failed:', error.message);
  process.exit(1);
}

const db = admin.database();

// ==================== REDIS & QUEUE SETUP ====================

const redis = new Redis(config.redis);
const wateringQueue = new Queue('watering', { connection: redis });

redis.on('connect', () => console.log('✅ Redis connected'));
redis.on('error', (err) => console.error('❌ Redis error:', err.message));

// Track last watering time untuk prevent spam
const lastWateringTime = {};

// ==================== WATERING WORKER ====================

const wateringWorker = new Worker(
  'watering',
  async (job) => {
    const { type, potNumbers, pompaAir, pompaPupuk, duration, scheduleId } = job.data;

    console.log(`\n💧 Processing Job: ${job.id}`);
    console.log(`   Type: ${type}`);
    console.log(`   Pots: [${potNumbers.join(', ')}]`);
    console.log(`   Duration: ${duration}s`);

    try {
      // Prepare aktuator updates
      const updates = {};
      if (pompaAir) updates['mosvet_1'] = true;
      if (pompaPupuk) updates['mosvet_2'] = true;

      // Turn ON valves for selected pots
      for (const pot of potNumbers) {
        if (pot >= 1 && pot <= 5) {
          updates[`mosvet_${pot + 2}`] = true; // pot 1 → mosvet_3, etc.
        }
      }

      // Turn ON
      console.log('   🔛 Turning ON:', Object.keys(updates).join(', '));
      await db.ref('aktuator').update(updates);

      // Wait for duration with progress logging
      const startTime = Date.now();
      const endTime = startTime + duration * 1000;

      while (Date.now() < endTime) {
        const remaining = Math.ceil((endTime - Date.now()) / 1000);
        if (remaining % 10 === 0 || remaining <= 5) {
          console.log(`   ⏳ ${remaining}s remaining...`);
        }
        await sleep(1000);
      }

      // Turn OFF
      const offUpdates = {};
      for (const key in updates) {
        offUpdates[key] = false;
      }
      console.log('   🔴 Turning OFF');
      await db.ref('aktuator').update(offUpdates);

      // Log history
      await logHistory(type, potNumbers, duration);

      // Update last watering time
      for (const pot of potNumbers) {
        lastWateringTime[`pot_${pot}`] = Date.now();
      }

      console.log(`   ✅ Job completed successfully`);
      return { success: true, duration, pots: potNumbers };
    } catch (error) {
      console.error(`   ❌ Job failed:`, error.message);

      // Safety: Turn OFF everything
      try {
        await db.ref('aktuator').update({
          mosvet_1: false,
          mosvet_2: false,
          mosvet_3: false,
          mosvet_4: false,
          mosvet_5: false,
          mosvet_6: false,
          mosvet_7: false,
          mosvet_8: false, // Pengaduk
        });
        console.log('   🛡️ Safety: All aktuators turned OFF');
      } catch (safetyError) {
        console.error('   ⚠️ Safety OFF failed:', safetyError.message);
      }

      throw error;
    }
  },
  {
    connection: redis,
    concurrency: config.worker.concurrency,
    removeOnComplete: { count: 100 }, // Keep last 100 completed jobs
    removeOnFail: { count: 50 }, // Keep last 50 failed jobs
  }
);

wateringWorker.on('completed', (job) => {
  console.log(`✅ Worker completed job ${job.id}`);
});

wateringWorker.on('failed', (job, err) => {
  console.error(`❌ Worker failed job ${job?.id}:`, err.message);
});

// ==================== WAKTU MODE (TIME SCHEDULER) ====================

let lastScheduleCheck = {};

async function checkScheduledWatering() {
  try {
    const snapshot = await db.ref('kontrol').once('value');
    const kontrolConfig = snapshot.val();

    if (!kontrolConfig || !kontrolConfig.waktu) {
      // Waktu mode disabled
      return;
    }

    const now = new Date();
    const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    const dateKey = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;

    // Check Jadwal 1
    if (kontrolConfig.waktu_1 && kontrolConfig.waktu_1 === currentTime) {
      const scheduleKey = `jadwal_1_${dateKey}_${currentTime}`;

      if (!lastScheduleCheck[scheduleKey]) {
        console.log(`\n🕐 JADWAL 1 TRIGGERED: ${currentTime}`);

        await wateringQueue.add(
          'schedule-1',
          {
            type: 'waktu_jadwal_1',
            potNumbers: [1, 2, 3, 4, 5], // All pots
            pompaAir: true,
            pompaPupuk: true,
            duration: kontrolConfig.durasi_1 || 60,
            scheduleId: scheduleKey,
          },
          {
            jobId: scheduleKey,
            removeOnComplete: true,
          }
        );

        lastScheduleCheck[scheduleKey] = true;
        console.log(`   📌 Added to queue: ${scheduleKey}`);
      }
    }

    // Check Jadwal 2
    if (kontrolConfig.waktu_2 && kontrolConfig.waktu_2 === currentTime) {
      const scheduleKey = `jadwal_2_${dateKey}_${currentTime}`;

      if (!lastScheduleCheck[scheduleKey]) {
        console.log(`\n🕑 JADWAL 2 TRIGGERED: ${currentTime}`);

        await wateringQueue.add(
          'schedule-2',
          {
            type: 'waktu_jadwal_2',
            potNumbers: [1, 2, 3, 4, 5], // All pots
            pompaAir: true,
            pompaPupuk: true,
            duration: kontrolConfig.durasi_2 || 60,
            scheduleId: scheduleKey,
          },
          {
            jobId: scheduleKey,
            removeOnComplete: true,
          }
        );

        lastScheduleCheck[scheduleKey] = true;
        console.log(`   📌 Added to queue: ${scheduleKey}`);
      }
    }

    // Cleanup old schedule checks (> 2 menit)
    const twoMinutesAgo = Date.now() - 120000;
    for (const key in lastScheduleCheck) {
      if (key.includes(dateKey)) continue; // Keep today's
      delete lastScheduleCheck[key];
    }
  } catch (error) {
    console.error('❌ Error checking scheduled watering:', error.message);
  }
}

// Run check setiap 30 detik
setInterval(checkScheduledWatering, config.worker.checkInterval);
console.log(`✅ Waktu Mode scheduler started (check every ${config.worker.checkInterval / 1000}s)`);

// ==================== SENSOR MODE (THRESHOLD MONITORING) ====================

async function setupSensorMonitoring() {
  console.log('✅ Sensor Mode monitoring started');

  db.ref('data').on('value', async (snapshot) => {
    try {
      const sensorData = snapshot.val();
      if (!sensorData) return;

      const configSnapshot = await db.ref('kontrol').once('value');
      const kontrolConfig = configSnapshot.val();

      if (!kontrolConfig || !kontrolConfig.otomatis) {
        // Sensor mode disabled
        return;
      }

      const batasBawah = kontrolConfig.batas_bawah || 40;
      const batasAtas = kontrolConfig.batas_atas || 100;
      const durasiSensor = kontrolConfig.durasi_sensor || 60;
      const modeSensor = kontrolConfig.mode_sensor || 'fixed'; // 'fixed' or 'smart'

      // Check each pot
      for (let i = 1; i <= 5; i++) {
        const soilKey = `soil_${i}`;
        const soilValue = parseInt(sensorData[soilKey]) || 0;

        if (soilValue < batasBawah) {
          const potKey = `pot_${i}`;
          const lastTime = lastWateringTime[potKey];

          // Debounce: minimum 2 menit antar penyiraman
          if (lastTime && Date.now() - lastTime < config.worker.sensorDebounce) {
            const remainingSeconds = Math.ceil((config.worker.sensorDebounce - (Date.now() - lastTime)) / 1000);
            console.log(`⏳ POT ${i}: Cooldown active (${remainingSeconds}s remaining)`);
            continue;
          }

          console.log(`\n🌡️ SENSOR TRIGGERED: POT ${i}`);
          console.log(`   Soil moisture: ${soilValue}% < ${batasBawah}%`);
          console.log(`   Mode: ${modeSensor}, Duration: ${durasiSensor}s`);

          const jobId = `sensor-pot-${i}-${Date.now()}`;
          await wateringQueue.add(
            `sensor-pot-${i}`,
            {
              type: 'sensor_threshold',
              potNumbers: [i],
              pompaAir: true,
              pompaPupuk: false, // No pupuk for sensor mode
              duration: durasiSensor,
              scheduleId: jobId,
              sensorData: { soilValue, batasBawah, batasAtas, mode: modeSensor },
            },
            {
              jobId,
              removeOnComplete: true,
              priority: 1, // Higher priority for sensor-triggered
            }
          );

          console.log(`   📌 Added to queue: ${jobId}`);
        }
      }
    } catch (error) {
      console.error('❌ Error in sensor monitoring:', error.message);
    }
  });
}

setupSensorMonitoring();

// ==================== HISTORY LOGGING ====================

async function logHistory(type, potNumbers, duration) {
  try {
    const now = new Date();
    const dateKey = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;
    const timeKey = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    // Get current sensor data
    const sensorSnapshot = await db.ref('data').once('value');
    const sensorData = sensorSnapshot.val() || {};

    await db.ref(`history/${dateKey}/${timeKey}`).set({
      timestamp: now.getTime(),
      type: type,
      pots: potNumbers,
      duration: duration,
      ...sensorData,
    });

    console.log(`   📊 History logged: ${dateKey} ${timeKey}`);
  } catch (error) {
    console.error('   ⚠️ Failed to log history:', error.message);
  }
}

// ==================== PERIODIC HISTORY LOGGING ====================

// Auto-log sensor data setiap 10 menit (independent from watering)
const autoLogJob = new cron.CronJob('*/10 * * * *', async () => {
  try {
    const sensorSnapshot = await db.ref('data').once('value');
    const sensorData = sensorSnapshot.val();

    if (sensorData) {
      const now = new Date();
      const dateKey = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;
      const timeKey = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

      await db.ref(`history/${dateKey}/${timeKey}`).set({
        timestamp: now.getTime(),
        type: 'auto_log',
        ...sensorData,
      });

      console.log(`📊 Auto-logged sensor data: ${timeKey}`);
    }
  } catch (error) {
    console.error('❌ Auto-log failed:', error.message);
  }
});

autoLogJob.start();
console.log('✅ Auto history logging started (every 10 minutes)');

// ==================== CLEANUP OLD HISTORY (DAILY) ====================

const cleanupJob = new cron.CronJob('0 2 * * *', async () => {
  // Run daily at 2 AM
  try {
    console.log('\n🧹 Running history cleanup...');
    const daysToKeep = 30;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const historySnapshot = await db.ref('history').once('value');
    const historyData = historySnapshot.val();

    if (historyData) {
      let deletedCount = 0;
      for (const dateKey in historyData) {
        try {
          const [year, month, day] = dateKey.split('-').map(Number);
          const date = new Date(year, month - 1, day);

          if (date < cutoffDate) {
            await db.ref(`history/${dateKey}`).remove();
            deletedCount++;
            console.log(`   🗑️ Deleted: ${dateKey}`);
          }
        } catch (error) {
          console.error(`   ⚠️ Error deleting ${dateKey}:`, error.message);
        }
      }
      console.log(`✅ Cleanup completed: ${deletedCount} dates removed`);
    }
  } catch (error) {
    console.error('❌ Cleanup failed:', error.message);
  }
});

cleanupJob.start();
console.log('✅ History cleanup scheduled (daily at 2 AM)');

// ==================== UTILITIES ====================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== HEALTH CHECK ====================

async function healthCheck() {
  try {
    // Check Firebase connection
    await db.ref('.info/connected').once('value');

    // Check Redis connection
    await redis.ping();

    // Check queue
    const queueStatus = await wateringQueue.getJobCounts();

    console.log('\n💚 HEALTH CHECK:');
    console.log(`   Firebase: ✅ Connected`);
    console.log(`   Redis: ✅ Connected`);
    console.log(`   Queue: ${queueStatus.active} active, ${queueStatus.waiting} waiting`);
  } catch (error) {
    console.error('❤️‍🩹 HEALTH CHECK FAILED:', error.message);
  }
}

// Run health check every 5 minutes
setInterval(healthCheck, 300000);

// ==================== GRACEFUL SHUTDOWN ====================

async function shutdown() {
  console.log('\n🛑 Shutting down gracefully...');

  try {
    await wateringWorker.close();
    console.log('✅ Worker closed');

    await wateringQueue.close();
    console.log('✅ Queue closed');

    await redis.quit();
    console.log('✅ Redis disconnected');

    await admin.app().delete();
    console.log('✅ Firebase disconnected');

    process.exit(0);
  } catch (error) {
    console.error('❌ Shutdown error:', error.message);
    process.exit(1);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ==================== STARTUP COMPLETE ====================

console.log('\n✨ ApsGo Railway Worker is running!');
console.log('📊 Features enabled:');
console.log('   • Waktu Mode (Time-based scheduling)');
console.log('   • Sensor Mode (Threshold-based automation)');
console.log('   • Auto History Logging (every 10 min)');
console.log('   • History Cleanup (daily at 2 AM)');
console.log('   • Health Check (every 5 min)');
console.log('\n🎯 Worker is ready to process jobs...\n');

// Initial health check
setTimeout(healthCheck, 5000);
