/**
 * ApsGo Railway Worker
 * Background service untuk automation scheduling 24/7
 * Features:
 * - Waktu Mode: Scheduled watering by time
 * - Sensor Mode: Automatic watering by soil moisture threshold
 * - Redis Queue: Prevent race conditions & concurrent task management
 * - Firebase Realtime DB: Sync dengan Flutter app dan ESP32
 */

// ==================== SUPPRESS FIREBASE WARNINGS ====================

// Completely suppress Firebase SDK warnings
process.env.FIREBASE_DATABASE_EMULATOR_HOST = undefined;
process.env.FIRESTORE_EMULATOR_HOST = undefined;

// Override console.warn to filter Firebase warnings
const originalWarn = console.warn;
console.warn = function(...args) {
  const message = args.join(' ');
  // Suppress specific Firebase warnings
  if (message.includes('FIREBASE WARNING') || 
      message.includes('@firebase/database') ||
      message.includes('firebase/database')) {
    return; // Silent - don't log
  }
  originalWarn.apply(console, args);
};

// ==================== IMPORTS ====================

require('dotenv').config();
const admin = require('firebase-admin');
const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const cron = require('cron');

// ==================== CONFIGURATION ====================

// Set timezone untuk Indonesia (UTC+7)
process.env.TZ = process.env.TZ || 'Asia/Jakarta';

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
    checkInterval: 60000, // Check jadwal setiap 60 detik (reduced from 30s)
    sensorDebounce: 120000, // 2 menit minimum antar penyiraman per pot
  },
};

console.log('🚀 Starting ApsGo Railway Worker...');
console.log(`📡 Firebase Project: ${config.firebase.projectId}`);
console.log(`� Firebase DB URL: ${config.firebase.databaseURL}`);
console.log(`�📦 Redis: ${config.redis.host}:${config.redis.port}`);
console.log(`⏰ Timezone: ${process.env.TZ} (Current: ${new Date().toLocaleString('id-ID', {timeZone: 'Asia/Jakarta'})})`);

// ==================== ENVIRONMENT VALIDATION ====================

const requiredEnvs = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL', 
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_DATABASE_URL'
];

const missingEnvs = requiredEnvs.filter(env => !process.env[env]);
if (missingEnvs.length > 0) {
  console.error('❌ Missing required environment variables:');
  missingEnvs.forEach(env => console.error(`   - ${env}`));
  console.error('\n📋 To fix this:');
  console.error('1. Go to Railway Dashboard');
  console.error('2. Select your worker service');
  console.error('3. Go to Variables tab');
  console.error('4. Add the missing variables');
  console.error('5. Redeploy');
  process.exit(1);
}

console.log('✅ All required environment variables are set');

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

// Add error handlers for Firebase database
db.ref('.info/connected').on('value', (snap) => {
  if (snap.val() === true) {
    console.log('🔌 Firebase realtime connection active');
  }
});

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
      console.log('   📌 Firebase path: aktuator');
      console.log('   📝 Updates:', JSON.stringify(updates, null, 2));
      
      await updateFirebaseSmart('aktuator', updates);
      
      // (Verification skipped to avoid SDK timeout - update success already logged above)

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
      console.log('   🔴 Turning OFF:', Object.keys(offUpdates).join(', '));
      await updateFirebaseSmart('aktuator', offUpdates);

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
        await updateFirebaseSmart('aktuator', {
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

// Counter untuk tracking berapa kali check dilakukan
let checkCounter = 0;
let consecutiveFirebaseErrors = 0;

// Helper function untuk Firebase fetch dengan timeout
async function fetchWithTimeout(ref, timeoutMs = 10000) {
  return Promise.race([
    ref.once('value'),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Firebase fetch timeout')), timeoutMs)
    )
  ]);
}

// Fallback: Fetch via Firebase REST API (lebih reliable)
async function fetchKontrolViaREST() {
  const url = `${config.firebase.databaseURL}/kontrol.json`;
  console.log(`   [DEBUG] Trying REST API: ${url}`);
  
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000
  });
  
  if (!response.ok) {
    throw new Error(`REST API failed: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  console.log('   [DEBUG] REST API successful!');
  return data;
}

// Smart fetch: Try SDK first, fallback to REST if needed
async function fetchKontrolSmart() {
  try {
    console.log('   [DEBUG] Attempting SDK fetch...');
    const snapshot = await fetchWithTimeout(db.ref('kontrol'), 10000);
    consecutiveFirebaseErrors = 0; // Reset error counter
    return snapshot.val();
  } catch (sdkError) {
    console.warn('   ⚠️  SDK fetch failed, trying REST API...');
    consecutiveFirebaseErrors++;
    
    try {
      const data = await fetchKontrolViaREST();
      return data;
    } catch (restError) {
      console.error('   ❌ REST API also failed:', restError.message);
      throw new Error('Both SDK and REST API failed');
    }
  }
}

// Helper: Update Firebase via REST API (PATCH for merge update)
async function updateFirebaseViaREST(path, updates) {
  const url = `${config.firebase.databaseURL}/${path}.json`;
  console.log(`   [DEBUG] REST API PATCH: ${url}`);
  
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
    timeout: 10000
  });
  
  if (!response.ok) {
    throw new Error(`REST PATCH failed: ${response.status}`);
  }
  
  const result = await response.json();
  console.log('   [DEBUG] REST API update successful!');
  return result;
}

// Helper: Update with timeout wrapper
async function updateWithTimeout(ref, updates, timeoutMs = 10000) {
  return Promise.race([
    ref.update(updates),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Firebase update timeout')), timeoutMs)
    )
  ]);
}

// Smart update: Try SDK first, fallback to REST if timeout
async function updateFirebaseSmart(path, updates) {
  try {
    console.log(`   [DEBUG] Attempting SDK update to ${path}...`);
    await updateWithTimeout(db.ref(path), updates, 10000);
    console.log('   ✅ Firebase SDK update successful');
    return true;
  } catch (sdkError) {
    console.warn(`   ⚠️  SDK update failed, trying REST API...`);
    
    try {
      await updateFirebaseViaREST(path, updates);
      console.log('   ✅ Firebase REST update successful');
      return true;
    } catch (restError) {
      console.error('   ❌ REST update also failed:', restError.message);
      throw new Error('Both SDK and REST update failed');
    }
  }
}

// Helper: Set Firebase via REST API (PUT for overwrite)
async function setFirebaseViaREST(path, data) {
  const url = `${config.firebase.databaseURL}/${path}.json`;
  
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    timeout: 10000
  });
  
  if (!response.ok) {
    throw new Error(`REST PUT failed: ${response.status}`);
  }
  
  return await response.json();
}

// Helper: Set with timeout wrapper
async function setWithTimeout(ref, data, timeoutMs = 10000) {
  return Promise.race([
    ref.set(data),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Firebase set timeout')), timeoutMs)
    )
  ]);
}

// Smart set: Try SDK first, fallback to REST if timeout
async function setFirebaseSmart(path, data) {
  try {
    await setWithTimeout(db.ref(path), data, 10000);
    return true;
  } catch (sdkError) {
    try {
      await setFirebaseViaREST(path, data);
      return true;
    } catch (restError) {
      throw new Error('Both SDK and REST set failed');
    }
  }
}

// Smart read: Try SDK first, fallback to REST if timeout (for any path)
async function readFirebaseSmart(path) {
  try {
    const snapshot = await fetchWithTimeout(db.ref(path), 10000);
    return snapshot.val();
  } catch (sdkError) {
    const url = `${config.firebase.databaseURL}/${path}.json`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });
    
    if (!response.ok) {
      throw new Error(`REST GET failed: ${response.status}`);
    }
    
    return await response.json();
  }
}

async function checkScheduledWatering() {
  checkCounter++;
  console.log(`\n🔎 [DEBUG] checkScheduledWatering() called - Counter: ${checkCounter}`);
  
  try {
    console.log('   [DEBUG] Fetching Firebase /kontrol...');
    
    // Use smart fetch (SDK with REST fallback)
    const kontrolConfig = await fetchKontrolSmart();
    
    console.log(`   [DEBUG] Kontrol config received:`, kontrolConfig ? 'EXISTS' : 'NULL');
    
    if (kontrolConfig) {
      console.log(`   [DEBUG] Kontrol data:`, JSON.stringify(kontrolConfig, null, 2));
    }

    const now = new Date();
    const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    const currentSeconds = now.getSeconds();
    const dateKey = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;
    
    // 🔍 VERBOSE LOG: Log setiap check untuk memastikan fungsi berjalan
    console.log(`\n⏱️  CHECK #${checkCounter}: ${currentTime}:${currentSeconds.toString().padStart(2, '0')} | Mode: ${kontrolConfig?.waktu ? '✅' : '❌'}`);
    
    // Log detail setiap 3 menit ATAU jika menit habis dibagi 5
    if (checkCounter % 3 === 0 || now.getMinutes() % 5 === 0) {
      console.log(`   📅 Date: ${dateKey}`);
      console.log(`   🕐 Current: ${currentTime} (${now.toLocaleString('id-ID', {timeZone: 'Asia/Jakarta'})})`);
      console.log(`   Mode Waktu: ${kontrolConfig?.waktu ? '✅ ENABLED' : '❌ DISABLED'}`);
      if (kontrolConfig?.waktu) {
        console.log(`   Jadwal 1: ${kontrolConfig.waktu_1 || 'not set'} ${kontrolConfig.waktu_1 === currentTime ? '🔔 MATCH!' : ''}`);
        console.log(`   Jadwal 2: ${kontrolConfig.waktu_2 || 'not set'} ${kontrolConfig.waktu_2 === currentTime ? '🔔 MATCH!' : ''}`);
      }
    }

    if (!kontrolConfig || !kontrolConfig.waktu) {
      // Waktu mode disabled
      console.log(`   [DEBUG] Exiting early - kontrolConfig: ${kontrolConfig ? 'exists' : 'null'}, waktu: ${kontrolConfig?.waktu}`);
      return;
    }

    if (kontrolConfig.waktu_1 && kontrolConfig.waktu_1 === currentTime) {
      const scheduleKey = `jadwal_1_${dateKey}_${currentTime.replace(':', '_')}`;

      if (!lastScheduleCheck[scheduleKey]) {
        console.log(`\n🕐 JADWAL 1 TRIGGERED: ${currentTime}`);
        console.log(`   🎯 Attempting to add job to queue...`);

        try {
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
          console.log(`   ✅ Successfully added to queue: ${scheduleKey}`);
          
          // Check queue status
          const queueStatus = await wateringQueue.getJobCounts();
          console.log(`   📊 Queue status: ${queueStatus.active} active, ${queueStatus.waiting} waiting`);
        } catch (queueError) {
          console.error(`   ❌ Failed to add to queue:`, queueError.message);
        }
      } else {
        console.log(`   ⏭️  Jadwal 1 already triggered: ${scheduleKey}`);
      }
    }

    // Check Jadwal 2
    if (kontrolConfig.waktu_2 && kontrolConfig.waktu_2 === currentTime) {
      const scheduleKey = `jadwal_2_${dateKey}_${currentTime.replace(':', '_')}`;

      if (!lastScheduleCheck[scheduleKey]) {
        console.log(`\n🕑 JADWAL 2 TRIGGERED: ${currentTime}`);
        console.log(`   🎯 Attempting to add job to queue...`);

        try {
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
          console.log(`   ✅ Successfully added to queue: ${scheduleKey}`);
          
          // Check queue status
          const queueStatus = await wateringQueue.getJobCounts();
          console.log(`   📊 Queue status: ${queueStatus.active} active, ${queueStatus.waiting} waiting`);
        } catch (queueError) {
          console.error(`   ❌ Failed to add to queue:`, queueError.message);
        }
      } else {
        console.log(`   ⏭️  Jadwal 2 already triggered: ${scheduleKey}`);
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
    console.error('[DEBUG] Error type:', error.constructor.name);
    console.error('[DEBUG] Stack trace:', error.stack);
    
    if (error.message === 'Firebase fetch timeout') {
      console.error('⚠️  Firebase is not responding! Network or connection issue.');
      console.error('   This could be:');
      console.error('   - Slow network connection');
      console.error('   - Firebase Realtime DB throttling');
      console.error('   - Security rules blocking access');
    }
    
    // Continue running - don't crash worker
  }
}

// Run check setiap 60 detik
setInterval(async () => {
  try {
    await checkScheduledWatering();
  } catch (error) {
    console.error('❌ Error in scheduled check interval:', error.message);
    console.error(error.stack);
  }
}, config.worker.checkInterval);
console.log(`✅ Waktu Mode scheduler started (check every ${config.worker.checkInterval / 1000}s)`);

// Jalankan check pertama kali setelah 8 detik (setelah diagnostic selesai)
setTimeout(async () => {
  try {
    console.log('\n🚀 Running first schedule check immediately...');
    console.log('[DEBUG] About to call checkScheduledWatering()...');
    await checkScheduledWatering();
    console.log('[DEBUG] checkScheduledWatering() returned');
    console.log('✅ First check completed successfully');
  } catch (error) {
    console.error('❌ First check failed:', error.message);
    console.error('[DEBUG] Error stack:', error.stack);
  }
}, 8000);

// ==================== SENSOR MODE (THRESHOLD MONITORING) ====================

let sensorCheckCounter = 0;

async function setupSensorMonitoring() {
  console.log('✅ Sensor Mode monitoring started');

  db.ref('data').on('value', async (snapshot) => {
    sensorCheckCounter++;
    
    try {
      const sensorData = snapshot.val();
      if (!sensorData) {
        console.log('⚠️  Sensor data is null/empty');
        return;
      }

      const configSnapshot = await fetchWithTimeout(db.ref('kontrol'), 10000);
      const kontrolConfig = configSnapshot.val();

      // Log sensor check (verbose hanya setiap 10 kali)
      if (sensorCheckCounter % 10 === 0) {
        console.log(`\n🌡️  SENSOR CHECK #${sensorCheckCounter} | Mode Otomatis: ${kontrolConfig?.otomatis ? '✅' : '❌'}`);
      }

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

    // Get current sensor data with timeout
    const sensorData = await readFirebaseSmart('data') || {};

    await setFirebaseSmart(`history/${dateKey}/${timeKey}`, {
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
    const sensorData = await readFirebaseSmart('data');

    if (sensorData) {
      const now = new Date();
      const dateKey = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;
      const timeKey = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

      await setFirebaseSmart(`history/${dateKey}/${timeKey}`, {
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

    const historyData = await readFirebaseSmart('history');

    if (historyData) {
      let deletedCount = 0;
      for (const dateKey in historyData) {
        try {
          const [year, month, day] = dateKey.split('-').map(Number);
          const date = new Date(year, month - 1, day);

          if (date < cutoffDate) {
            // Use REST API DELETE
            const url = `${config.firebase.databaseURL}/history/${dateKey}.json`;
            await fetch(url, { method: 'DELETE', timeout: 10000 });
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

// ==================== MANUAL TEST FUNCTIONS ====================

// 🧪 Test scheduler sekarang juga (untuk debugging)
async function testSchedulerNow() {
  try {
    console.log('\n🧪 MANUAL TEST: Triggering test watering job NOW...');
    
    const now = new Date();
    const testJobId = `manual-test-${now.getTime()}`;
    
    await wateringQueue.add(
      'manual-test',
      {
        type: 'manual_test',
        potNumbers: [1], // Test dengan 1 pot saja
        pompaAir: true,
        pompaPupuk: false,
        duration: 10, // 10 detik test
        scheduleId: testJobId,
      },
      {
        jobId: testJobId,
        removeOnComplete: true,
        priority: 10, // Highest priority
      }
    );
    
    console.log(`✅ Test job added: ${testJobId}`);
    console.log('   Watch for job processing logs...');
  } catch (error) {
    console.error('❌ Test scheduler failed:', error.message);
  }
}

// 🔍 Check Firebase aktuator node structure
async function checkAktuatorNode() {
  try {
    console.log('\n🔍 CHECKING AKTUATOR NODE...');
    const aktuatorData = await readFirebaseSmart('aktuator');
    
    if (!aktuatorData) {
      console.log('❌ Aktuator node NOT FOUND in Firebase!');
      console.log('   Creating default aktuator structure...');
      
      await setFirebaseSmart('aktuator', {
        mosvet_1: false,  // Pompa Air
        mosvet_2: false,  // Pompa Pupuk
        mosvet_3: false,  // Pot 1
        mosvet_4: false,  // Pot 2
        mosvet_5: false,  // Pot 3
        mosvet_6: false,  // Pot 4
        mosvet_7: false,  // Pot 5
        mosvet_8: false,  // Pengaduk
      });
      
      console.log('✅ Aktuator node created with defaults');
    } else {
      console.log('✅ Aktuator node exists:');
      for (const key in aktuatorData) {
        console.log(`   ${key}: ${aktuatorData[key]}`);
      }
      
      // Validate all required mosvets exist
      const required = ['mosvet_1', 'mosvet_2', 'mosvet_3', 'mosvet_4', 'mosvet_5', 'mosvet_6', 'mosvet_7', 'mosvet_8'];
      const missing = required.filter(key => !(key in aktuatorData));
      
      if (missing.length > 0) {
        console.log(`⚠️  Missing mosvets: ${missing.join(', ')}`);
        console.log('   Adding missing mosvets...');
        
        const updates = {};
        missing.forEach(key => updates[key] = false);
        await updateFirebaseSmart('aktuator', updates);
        
        console.log('✅ Missing mosvets added');
      }
    }
  } catch (error) {
    console.error('❌ Aktuator check failed:', error.message);
  }
}

// 🕐 Show current time in multiple formats
async function showCurrentTime() {
  try {
    const now = new Date();
    console.log('\n🕐 CURRENT TIME ANALYSIS:');
    console.log(`   Server Local: ${now.toString()}`);
    console.log(`   Asia/Jakarta: ${now.toLocaleString('id-ID', {timeZone: 'Asia/Jakarta'})}`);
    console.log(`   ISO: ${now.toISOString()}`);
    console.log(`   Unix: ${now.getTime()}`);
    console.log(`   TZ Env: ${process.env.TZ}`);
    console.log(`   HH:MM Format: ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`);
    
    // Check Firebase kontrol waktu
    console.log('[DEBUG] Fetching kontrol for time analysis...');
    const snapshot = await fetchWithTimeout(db.ref('kontrol'), 10000);
    const kontrolConfig = snapshot.val();
    console.log('[DEBUG] Kontrol fetch successful');
    
    if (kontrolConfig) {
      console.log('\n📋 FIREBASE KONTROL:');
      console.log(`   Mode Waktu: ${kontrolConfig.waktu ? 'ENABLED ✅' : 'DISABLED ❌'}`);
      console.log(`   Waktu 1: ${kontrolConfig.waktu_1 || 'not set'}`);
      console.log(`   Waktu 2: ${kontrolConfig.waktu_2 || 'not set'}`);
      console.log(`   Durasi 1: ${kontrolConfig.durasi_1 || 'not set'}s`);
      console.log(`   Durasi 2: ${kontrolConfig.durasi_2 || 'not set'}s`);
    } else {
      console.log('\n❌ Firebase kontrol node is empty!');
    }
  } catch (error) {
    console.error('❌ Time check failed:', error.message);
  }
}

// ==================== HEALTH CHECK ====================

async function healthCheck() {
  try {
    // Check Firebase connection
    await db.ref('.info/connecte (skip SDK, just check via config)
    const firebaseOk = config.firebase.databaseURL ? true : false;

    // Check Redis connection
    await redis.ping();

    // Check queue
    const queueStatus = await wateringQueue.getJobCounts();

    console.log('\n💚 HEALTH CHECK:');
    console.log(`   Firebase: ${firebaseOk ? '✅' : '❌'}nnected`);
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

// ==================== PREVENT CRASHES ====================

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error.message);
  console.error(error.stack);
  // Don't exit - try to keep worker running
  console.log('⚠️  Worker continuing despite error...');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise);
  console.error('Reason:', reason);
  // Don't exit - try to keep worker running
  console.log('⚠️  Worker continuing despite rejection...');
});

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

// ==================== KEEP-ALIVE MECHANISM ====================

// Heartbeat every 30 seconds to prevent Railway from stopping container
setInterval(() => {
  const uptime = Math.floor(process.uptime());
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  console.log(`💓 Heartbeat: Worker alive for ${hours}h ${minutes}m`);
}, 30000);

// Verify Firebase connection on startup
setTimeout(async () => {
  try {
    console.log('🔍 Verifying Firebase connection...');
    console.log('[DEBUG] Testing Firebase read with timeout...');
    const snapshot = await fetchWithTimeout(db.ref('kontrol'), 10000);
    console.log('[DEBUG] Firebase read successful!');
    const data = snapshot.val();
    if (data) {
      console.log('✅ Firebase /kontrol readable - waktu mode:', data.waktu ? 'ENABLED' : 'DISABLED');
      if (data.waktu) {
        console.log(`   📅 Schedules: ${data.waktu_1 || 'none'} / ${data.waktu_2 || 'none'}`);
      }
    } else {
      console.log('⚠️  Firebase /kontrol is empty - waiting for Flutter app to set schedule');
    }
  } catch (error) {
    console.error('❌ Firebase verification failed:', error.message);
  }
}, 3000);

// Run diagnostic checks on startup
setTimeout(async () => {
  try {
    console.log('\n🔧 RUNNING DIAGNOSTIC CHECKS...');
    await showCurrentTime();
    await checkAktuatorNode();
    console.log('\n✅ Diagnostic checks completed');
    console.log('\n💡 TIP: To test scheduler manually, check the logs above for current time');
    console.log('   Then set waktu_1 or waktu_2 in Firebase to match current time + 1 minute');
  } catch (error) {
    console.error('❌ Diagnostic checks failed:', error.message);
    console.error(error.stack);
  }
}, 5000);

// Auto-run test scheduler setiap 10 menit untuk memastikan worker alive
setInterval(() => {
  const now = new Date();
  // Run at :00, :10, :20, :30, :40, :50
  if (now.getMinutes() % 10 === 0 && now.getSeconds() < 30) {
    showCurrentTime();
  }
}, 30000);

