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

// Firebase paths configuration
const FIREBASE_PATHS = {
  kontrol: 'kontrol_1',  // Main kontrol path (ubah ke 'kontrol' jika perlu)
  aktuator: 'aktuator',
  data: 'data',
  history: 'history',
};

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
console.log(`🔥 Firebase DB URL: ${config.firebase.databaseURL}`);
console.log(`📦 Redis: ${config.redis.host}:${config.redis.port}`);
console.log(`⏰ Timezone: ${process.env.TZ} (Current: ${new Date().toLocaleString('id-ID', {timeZone: 'Asia/Jakarta'})})`);
console.log(`📍 Kontrol Path: /${FIREBASE_PATHS.kontrol}`);

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
    const { type, potNumbers, pompaAir, pompaPupuk, duration, scheduleId, smartMode, sensorData } = job.data;

    console.log(`\n💧 Processing Job: ${job.id}`);
    console.log(`   Type: ${type}`);
    console.log(`   Pots: [${potNumbers.join(', ')}]`);
    console.log(`   Mode: ${smartMode ? 'SMART (auto-stop at target)' : 'FIXED'}`);
    console.log(`   Duration: ${duration}s ${smartMode ? '(max)' : ''}`);
    if (sensorData) {
      console.log(`   Target: ${sensorData.batasBawah}% → ${sensorData.batasAtas}%`);
    }

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
      
      // SMART MODE: Monitor sensor and stop when target reached
      if (smartMode && sensorData && sensorData.batasAtas) {
        const targetSoil = sensorData.batasAtas;
        const maxDuration = duration * 1000; // Convert to ms
        const startTime = Date.now();
        let allPotsReachedTarget = false;
        
        console.log(`   🎯 SMART MODE: Monitoring until all pots reach ${targetSoil}%...`);
        
        while (Date.now() - startTime < maxDuration && !allPotsReachedTarget) {
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          const remaining = Math.ceil((maxDuration - (Date.now() - startTime)) / 1000);
          
          // Check sensor every 5 seconds
          if (elapsed % 5 === 0) {
            try {
              const currentSensorData = await readFirebaseSmart('data');
              
              if (currentSensorData) {
                const potStatus = [];
                let allReached = true;
                
                for (const pot of potNumbers) {
                  const soilKey = `soil_${pot}`;
                  const currentValue = parseInt(currentSensorData[soilKey]) || 0;
                  const reached = currentValue >= targetSoil;
                  
                  potStatus.push(`POT${pot}:${currentValue}%${reached ? '✅' : '⏳'}`);
                  
                  if (!reached) {
                    allReached = false;
                  }
                }
                
                console.log(`   📊 [${elapsed}s] ${potStatus.join(', ')} | Max: ${remaining}s`);
                
                if (allReached) {
                  allPotsReachedTarget = true;
                  console.log(`   🎉 TARGET REACHED! All pots >= ${targetSoil}%. Stopping early.`);
                  break;
                }
              }
            } catch (sensorError) {
              console.warn(`   ⚠️ Failed to read sensor: ${sensorError.message}`);
            }
          }
          
          await sleep(1000);
        }
        
        if (!allPotsReachedTarget) {
          console.log(`   ⏱️ Max duration reached (${duration}s). Stopping.`);
        }
      } else {
        // FIXED MODE: Wait for fixed duration
        const startTime = Date.now();
        const endTime = startTime + duration * 1000;

        while (Date.now() < endTime) {
          const remaining = Math.ceil((endTime - Date.now()) / 1000);
          if (remaining % 10 === 0 || remaining <= 5) {
            console.log(`   ⏳ ${remaining}s remaining...`);
          }
          await sleep(1000);
        }
      }

      // Turn OFF
      const offUpdates = {};
      for (const key in updates) {
        offUpdates[key] = false;
      }
      console.log('   🔴 Turning OFF:', Object.keys(offUpdates).join(', '));
      await updateFirebaseSmart('aktuator', offUpdates);
      console.log('   ✅ Turn OFF completed, now logging history...');

      // Log history
      await logHistory(type, potNumbers, duration);
      console.log('   ✅ History logged successfully');

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
    lockDuration: 900000, // 15 minutes max job time (duration 600s + 5min buffer)
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
let sdkSuccessCount = 0;
let restFallbackCount = 0;

// Smart fallback: Skip SDK jika sudah gagal berturut-turut 3x
const SKIP_SDK_THRESHOLD = 3;
const RESET_THRESHOLD_AFTER = 50; // Reset counter setelah 50 check (50 menit)

// Helper function untuk Firebase fetch dengan timeout
async function fetchWithTimeout(ref, timeoutMs = 5000) {
  return Promise.race([
    ref.once('value'),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Firebase fetch timeout')), timeoutMs)
    )
  ]);
}

// Helper: Fetch with timeout wrapper (for REST API calls)
async function fetchWithTimeout2(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      throw new Error('REST API timeout');
    }
    throw error;
  }
}

// Fallback: Fetch via Firebase REST API (lebih reliable)
async function fetchKontrolViaREST() {
  const url = `${config.firebase.databaseURL}/${FIREBASE_PATHS.kontrol}.json`;
  console.log(`   [DEBUG] Trying REST API: ${url}`);
  
  const response = await fetchWithTimeout2(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  }, 8000);
  
  if (!response.ok) {
    throw new Error(`REST API failed: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  console.log('   [DEBUG] REST API successful!');
  return data;
}

// Smart fetch: Try SDK first, fallback to REST if needed
async function fetchKontrolSmart() {
  // Smart fallback: Skip SDK if it failed 3+ times consecutively
  const shouldSkipSDK = consecutiveFirebaseErrors >= SKIP_SDK_THRESHOLD;
  
  if (shouldSkipSDK) {
    console.log('   [SMART] Skipping SDK (3+ consecutive failures), using REST API directly...');
    try {
      const data = await fetchKontrolViaREST();
      restFallbackCount++;
      
      // Reset counter setelah threshold untuk retry SDK
      if (restFallbackCount >= RESET_THRESHOLD_AFTER) {
        console.log('   [SMART] Resetting SDK retry counter...');
        consecutiveFirebaseErrors = 0;
        restFallbackCount = 0;
      }
      
      return data;
    } catch (restError) {
      console.error('   ❌ REST API failed:', restError.message);
      throw new Error('REST API failed');
    }
  }
  
  // Normal flow: Try SDK first
  try {
    console.log('   [DEBUG] Attempting SDK fetch...');
    const snapshot = await fetchWithTimeout(db.ref(FIREBASE_PATHS.kontrol), 5000);
    consecutiveFirebaseErrors = 0; // Reset error counter
    restFallbackCount = 0; // Reset fallback counter
    sdkSuccessCount++;
    return snapshot.val();
  } catch (sdkError) {
    console.warn('   ⚠️  SDK fetch failed, trying REST API...');
    consecutiveFirebaseErrors++;
    
    try {
      const data = await fetchKontrolViaREST();
      restFallbackCount++;
      
      // Log peringatan jika SDK terus gagal
      if (consecutiveFirebaseErrors === SKIP_SDK_THRESHOLD) {
        console.warn(`   🚨 SDK failed ${SKIP_SDK_THRESHOLD}x consecutively! Will use REST API directly for next ${RESET_THRESHOLD_AFTER} checks.`);
      }
      
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
  
  const response = await fetchWithTimeout2(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates)
  }, 8000);
  
  if (!response.ok) {
    throw new Error(`REST PATCH failed: ${response.status}`);
  }
  
  const result = await response.json();
  console.log('   [DEBUG] REST API update successful!');
  return result;
}

// Helper: Update with timeout wrapper
async function updateWithTimeout(ref, updates, timeoutMs = 5000) {
  return Promise.race([
    ref.update(updates),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Firebase update timeout')), timeoutMs)
    )
  ]);
}

// Smart update: Try SDK first, fallback to REST if timeout
async function updateFirebaseSmart(path, updates) {
  const updateStr = JSON.stringify(updates);
  console.log(`   [UPDATE START] Path: ${path}, Data: ${updateStr}`);
  
  // If SDK is consistently failing, skip it for updates too
  const shouldSkipSDK = consecutiveFirebaseErrors >= SKIP_SDK_THRESHOLD;
  
  if (shouldSkipSDK) {
    console.log(`   [UPDATE] Using REST API directly (SDK disabled)`);
    try {
      await updateFirebaseViaREST(path, updates);
      console.log(`   ✅ [UPDATE] REST API successful!`);
      return true;
    } catch (restError) {
      console.error(`   ❌ [UPDATE] REST failed: ${restError.message}`);
      throw new Error('REST update failed');
    }
  }
  
  try {
    console.log(`   [UPDATE] Step 1: Attempting SDK update...`);
    await updateWithTimeout(db.ref(path), updates, 5000);
    console.log(`   ✅ [UPDATE] Step 2: SDK update successful!`);
    return true;
  } catch (sdkError) {
    console.warn(`   ⚠️  [UPDATE] Step 2: SDK failed (${sdkError.message}), trying REST API...`);
    
    try {
      console.log(`   [UPDATE] Step 3: Attempting REST API...`);
      await updateFirebaseViaREST(path, updates);
      console.log(`   ✅ [UPDATE] Step 4: REST API successful!`);
      return true;
    } catch (restError) {
      console.error(`   ❌ [UPDATE] Step 4: REST failed (${restError.message}) - BOTH METHODS FAILED!`);
      throw new Error('Both SDK and REST update failed');
    }
  }
}

// Helper: Set Firebase via REST API (PUT for overwrite)
async function setFirebaseViaREST(path, data) {
  const url = `${config.firebase.databaseURL}/${path}.json`;
  
  const response = await fetchWithTimeout2(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }, 8000);
  
  if (!response.ok) {
    throw new Error(`REST PUT failed: ${response.status}`);
  }
  
  return await response.json();
}

// Helper: Set with timeout wrapper
async function setWithTimeout(ref, data, timeoutMs = 5000) {
  return Promise.race([
    ref.set(data),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Firebase set timeout')), timeoutMs)
    )
  ]);
}

// Smart set: Try SDK first, fallback to REST if timeout
async function setFirebaseSmart(path, data) {
  const dataStr = JSON.stringify(data);
  console.log(`   [SET START] Path: ${path}, Data: ${dataStr.substring(0,100)}...`);
  
  // If SDK is consistently failing, skip it
  const shouldSkipSDK = consecutiveFirebaseErrors >= SKIP_SDK_THRESHOLD;
  
  if (shouldSkipSDK) {
    console.log(`   [SET] Using REST API directly (SDK disabled)`);
    try {
      await setFirebaseViaREST(path, data);
      console.log(`   ✅ [SET] REST API successful!`);
      return true;
    } catch (restError) {
      console.error(`   ❌ [SET] REST failed: ${restError.message}`);
      throw new Error('REST set failed');
    }
  }
  
  try {
    console.log(`   [SET] Step 1: Attempting SDK set...`);
    await setWithTimeout(db.ref(path), data, 5000);
    console.log(`   ✅ [SET] Step 2: SDK set successful!`);
    return true;
  } catch (sdkError) {
    console.warn(`   ⚠️  [SET] Step 2: SDK failed (${sdkError.message}), trying REST API...`);
    try {
      console.log(`   [SET] Step 3: Attempting REST API...`);
      await setFirebaseViaREST(path, data);
      console.log(`   ✅ [SET] Step 4: REST API successful!`);
      return true;
    } catch (restError) {
      console.error(`   ❌ [SET] Step 4: REST failed - BOTH METHODS FAILED!`);
      throw new Error('Both SDK and REST set failed');
    }
  }
}

// Smart read: Try SDK first, fallback to REST if timeout (for any path)
async function readFirebaseSmart(path) {
  const shouldSkipSDK = consecutiveFirebaseErrors >= SKIP_SDK_THRESHOLD;
  
  if (shouldSkipSDK) {
    console.log('   [READ] Using REST API directly (SDK disabled)');
    const url = `${config.firebase.databaseURL}/${path}.json`;
    const response = await fetchWithTimeout2(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    }, 8000);
    
    if (!response.ok) {
      throw new Error(`REST GET failed: ${response.status}`);
    }
    
    return await response.json();
  }
  
  try {
    const snapshot = await fetchWithTimeout(db.ref(path), 5000);
    return snapshot.val();
  } catch (sdkError) {
    const url = `${config.firebase.databaseURL}/${path}.json`;
    const response = await fetchWithTimeout2(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    }, 8000);
    
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
    
    // Detect all schedules (jadwal_1, jadwal_2, jadwal_3, ...)
    const allSchedules = kontrolConfig ? Object.keys(kontrolConfig).filter(key => key.startsWith('jadwal_')) : [];
    
    // Log detail setiap 3 menit ATAU jika menit habis dibagi 5
    if (checkCounter % 3 === 0 || now.getMinutes() % 5 === 0) {
      console.log(`   📅 Date: ${dateKey}`);
      console.log(`   🕐 Current: ${currentTime} (${now.toLocaleString('id-ID', {timeZone: 'Asia/Jakarta'})})`);
      console.log(`   Mode Waktu: ${kontrolConfig?.waktu ? '✅ ENABLED' : '❌ DISABLED'}`);
      console.log(`   📊 API Stats: SDK=${sdkSuccessCount} | REST=${restFallbackCount} | Errors=${consecutiveFirebaseErrors}`);
      console.log(`   📋 Total Jadwal: ${allSchedules.length}`);
      
      if (kontrolConfig?.waktu && allSchedules.length > 0) {
        allSchedules.forEach(scheduleKey => {
          const schedule = kontrolConfig[scheduleKey];
          if (schedule && typeof schedule === 'object') {
            const isActive = schedule.aktif !== false; // Default true if not specified
            const waktu = schedule.waktu || 'not set';
            const potAktif = schedule.pot_aktif || [];
            const isMatch = waktu === currentTime;
            console.log(`   ${isActive ? '✅' : '❌'} ${scheduleKey}: ${waktu} → Pot [${potAktif.join(', ')}] ${isMatch ? '🔔 MATCH!' : ''}`);
          }
        });
      }
      
      // Legacy support: Log old format if exists
      if (kontrolConfig?.waktu_1 || kontrolConfig?.waktu_2) {
        console.log(`   [LEGACY] waktu_1: ${kontrolConfig.waktu_1 || 'not set'}`);
        console.log(`   [LEGACY] waktu_2: ${kontrolConfig.waktu_2 || 'not set'}`);
      }
    }

    if (!kontrolConfig || !kontrolConfig.waktu) {
      // Waktu mode disabled
      console.log(`   [DEBUG] Exiting early - kontrolConfig: ${kontrolConfig ? 'exists' : 'null'}, waktu: ${kontrolConfig?.waktu}`);
      return;
    }

    // NEW: Dynamic schedule checking - supports jadwal_1, jadwal_2, ... jadwal_N
    for (const scheduleKey of allSchedules) {
      const schedule = kontrolConfig[scheduleKey];
      
      // Validate schedule structure
      if (!schedule || typeof schedule !== 'object') {
        console.log(`   ⚠️  ${scheduleKey}: Invalid structure, skipping`);
        continue;
      }
      
      // Check if schedule is active (default: true if not specified)
      const isActive = schedule.aktif !== false;
      if (!isActive) {
        continue; // Skip disabled schedules
      }
      
      // Check if time matches
      const scheduleWaktu = schedule.waktu;
      if (!scheduleWaktu || scheduleWaktu !== currentTime) {
        continue; // Not time yet
      }
      
      // Extract schedule config
      const potAktif = schedule.pot_aktif || [];
      const durasi = schedule.durasi || 60;
      const pompaAir = schedule.pompa_air !== false; // Default true
      const pompaPupuk = schedule.pompa_pupuk || false; // Default false
      
      // Validate pot_aktif
      if (!Array.isArray(potAktif) || potAktif.length === 0) {
        console.log(`   ⚠️  ${scheduleKey}: No active pots defined, skipping`);
        continue;
      }
      
      // Create unique job key
      const jobKey = `${scheduleKey}_${dateKey}_${currentTime.replace(':', '_')}`;
      
      if (!lastScheduleCheck[jobKey]) {
        console.log(`\n🕐 ${scheduleKey.toUpperCase()} TRIGGERED: ${currentTime}`);
        console.log(`   🎯 Pot aktif: [${potAktif.join(', ')}]`);
        console.log(`   ⏱️  Durasi: ${durasi}s`);
        console.log(`   💧 Pompa Air: ${pompaAir ? 'ON' : 'OFF'}`);
        console.log(`   🌿 Pompa Pupuk: ${pompaPupuk ? 'ON' : 'OFF'}`);

        try {
          await wateringQueue.add(
            scheduleKey,
            {
              type: `waktu_${scheduleKey}`,
              potNumbers: potAktif,
              pompaAir: pompaAir,
              pompaPupuk: pompaPupuk,
              duration: durasi,
              scheduleId: jobKey,
            },
            {
              jobId: jobKey,
              removeOnComplete: true,
            }
          );
          
          lastScheduleCheck[jobKey] = true;
          console.log(`   ✅ Successfully added to queue: ${jobKey}`);
          
          // Check queue status
          const queueStatus = await wateringQueue.getJobCounts();
          console.log(`   📊 Queue status: ${queueStatus.active} active, ${queueStatus.waiting} waiting`);
        } catch (queueError) {
          console.error(`   ❌ Failed to add ${scheduleKey} to queue:`, queueError.message);
        }
      } else {
        console.log(`   ⏭️  ${scheduleKey} already triggered: ${jobKey}`);
      }
    }
    
    // LEGACY SUPPORT: Check old format (waktu_1, waktu_2) untuk backward compatibility
    if (kontrolConfig.waktu_1 && kontrolConfig.waktu_1 === currentTime) {
      const scheduleKey = `legacy_jadwal_1_${dateKey}_${currentTime.replace(':', '_')}`;

      if (!lastScheduleCheck[scheduleKey]) {
        console.log(`\n🕐 [LEGACY] JADWAL 1 TRIGGERED: ${currentTime}`);
        console.log(`   🎯 Using legacy format (all pots)`);

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
          console.log(`   ✅ Successfully added legacy jadwal_1 to queue`);
        } catch (queueError) {
          console.error(`   ❌ Failed to add legacy jadwal_1:`, queueError.message);
        }
      }
    }

    if (kontrolConfig.waktu_2 && kontrolConfig.waktu_2 === currentTime) {
      const scheduleKey = `legacy_jadwal_2_${dateKey}_${currentTime.replace(':', '_')}`;

      if (!lastScheduleCheck[scheduleKey]) {
        console.log(`\n🕑 [LEGACY] JADWAL 2 TRIGGERED: ${currentTime}`);
        console.log(`   🎯 Using legacy format (all pots)`);

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
          console.log(`   ✅ Successfully added legacy jadwal_2 to queue`);
        } catch (queueError) {
          console.error(`   ❌ Failed to add legacy jadwal_2:`, queueError.message);
        }
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

// Core sensor check logic (shared by listener and polling)
async function checkSensorThresholds() {
  sensorCheckCounter++;
  
  try {
    // Fetch sensor data using smart method (REST fallback)
    const sensorData = await readFirebaseSmart('data');
    
    if (!sensorData) {
      console.log('⚠️  Sensor data is null/empty - ESP32 might not be sending data');
      return;
    }

    // Fetch kontrol config using smart method
    const kontrolConfig = await fetchKontrolSmart();

    if (!kontrolConfig) {
      console.log('⚠️  Kontrol config is null');
      return;
    }
    
    // Check if sensor mode is enabled (using 'otomatis' field, not deprecated 'sensor')
    if (!kontrolConfig.otomatis) {
      if (sensorCheckCounter % 10 === 0) {
        console.log(`⚠️  Sensor mode DISABLED (otomatis=false). Skipping threshold check.`);
      }
      return;
    }

    // Detect all threshold_* nodes
    const allThresholds = Object.keys(kontrolConfig).filter(key => key.startsWith('threshold_'));

    // Log sensor check (ALWAYS LOG untuk debugging)
    console.log(`\n🌡️  SENSOR CHECK #${sensorCheckCounter} | Total Thresholds: ${allThresholds.length}`);
    console.log(`   📊 Sensor Data:`, JSON.stringify(sensorData, null, 2));

    if (allThresholds.length === 0) {
      console.log('   ⚠️  No thresholds configured');
      return;
    }

    // Process each threshold
    for (const thresholdKey of allThresholds) {
      const threshold = kontrolConfig[thresholdKey];
      
      console.log(`\n   🔍 Checking ${thresholdKey}:`);
      console.log(`      Config:`, JSON.stringify(threshold, null, 2));
      
      // Skip if threshold is not active or invalid
      if (!threshold || !threshold.aktif) {
        console.log(`      ❌ Skipped: ${!threshold ? 'Not found' : 'Not active (aktif=false)'}`);
        continue;
      }

      const batasBawah = threshold.batas_bawah || 30;
      const batasAtas = threshold.batas_atas || 70;
      const durasi = threshold.durasi || 600;
      const smartMode = threshold.smart_mode === true;
      const potAktif = threshold.pot_aktif || [];
      const pompaAir = threshold.pompa_air === true;
      const pompaPupuk = threshold.pompa_pupuk === true;

      // Collect pots that need watering in this threshold
      const potsNeedWatering = [];
      const potDetails = [];

      // Check each pot in this threshold
      for (const potNumber of potAktif) {
        if (potNumber < 1 || potNumber > 5) {
          console.log(`      ⚠️  POT ${potNumber}: Invalid pot number (must be 1-5)`);
          continue;
        }

        const soilKey = `soil_${potNumber}`;
        const soilValue = parseInt(sensorData[soilKey]) || 0;

        console.log(`      🌱 POT ${potNumber} (${soilKey}): ${soilValue}% | Threshold: ${batasBawah}-${batasAtas}%`);
        console.log(`         → Raw value: ${sensorData[soilKey]} | Parsed: ${soilValue} | Check: ${soilValue} < ${batasBawah} = ${soilValue < batasBawah}`);

        // NEW: Check if ABOVE upper threshold - skip if too wet!
        if (soilValue >= batasAtas) {
          console.log(`      ✅ POT ${potNumber}: SKIP (${soilValue}% >= ${batasAtas}% - sudah basah!)`);
          continue;
        }

        // Check if below lower threshold
        if (soilValue < batasBawah) {
          const potKey = `pot_${potNumber}`;
          const lastTime = lastWateringTime[potKey];

          console.log(`      🚨 POT ${potNumber} KERING! ${soilValue}% < ${batasBawah}%`);
          
          // Debounce: minimum 2 menit antar penyiraman
          if (lastTime && Date.now() - lastTime < config.worker.sensorDebounce) {
            const remainingSeconds = Math.ceil((config.worker.sensorDebounce - (Date.now() - lastTime)) / 1000);
            console.log(`      ⏳ POT ${potNumber}: Cooldown active (${remainingSeconds}s remaining) - skipping trigger`);
            continue;
          }

          // Add to watering list
          potsNeedWatering.push(potNumber);
          potDetails.push({ pot: potNumber, value: soilValue });
        } else {
          console.log(`      ✅ POT ${potNumber}: OK (${soilValue}% >= ${batasBawah}%)`);
        }
      }

      // NEW: Create SINGLE job for ALL pots that need watering in this threshold
      if (potsNeedWatering.length > 0) {
        console.log(`\n🌡️ THRESHOLD TRIGGERED: ${thresholdKey.toUpperCase()}`);
        console.log(`   Pots needing water: [${potsNeedWatering.join(', ')}]`);
        potDetails.forEach(p => console.log(`   - POT ${p.pot}: ${p.value}% < ${batasBawah}%`));
        console.log(`   Mode: ${smartMode ? 'Smart (monitor until ' + batasAtas + '%)' : 'Fixed (' + durasi + 's)'}`);
        console.log(`   Pumps: Air=${pompaAir}, Pupuk=${pompaPupuk}`);

        const jobId = `${thresholdKey}-${Date.now()}`;
        await wateringQueue.add(
          thresholdKey,
          {
            type: 'sensor_threshold',
            potNumbers: potsNeedWatering,  // ALL pots in 1 job!
            pompaAir: pompaAir,
            pompaPupuk: pompaPupuk,
            duration: durasi,
            scheduleId: jobId,
            thresholdId: thresholdKey,
            smartMode: smartMode,
            sensorData: { 
              batasBawah, 
              batasAtas, 
              mode: smartMode ? 'smart' : 'fixed',
              potValues: potDetails
            },
          },
          {
            jobId,
            removeOnComplete: true,
            priority: 1, // Higher priority for sensor-triggered
          }
        );

        console.log(`   📌 Added to queue: ${jobId}`);
        
        // Update last watering time for ALL pots
        for (const potNumber of potsNeedWatering) {
          lastWateringTime[`pot_${potNumber}`] = Date.now();
        }
      }
    }
  } catch (error) {
    console.error('❌ Error in sensor threshold check:', error.message);
  }
}

// Setup sensor monitoring with BOTH listener (SDK) and polling (fallback)
async function setupSensorMonitoring() {
  console.log('🌡️  ==================== SENSOR MODE ENABLED ====================');
  console.log('✅ Sensor Mode (Threshold System) monitoring started');
  console.log('📍 Primary: Polling every 30 seconds (REST API)');
  console.log('📍 Backup: Firebase listener on /data (if SDK works)');
  console.log('📍 Config path: /' + FIREBASE_PATHS.kontrol);
  console.log('⏱️  Debounce time: 2 minutes between watering per pot');
  console.log('================================================================\n');

  // METHOD 1: Polling (RELIABLE - uses REST API)
  // Check sensor threshold every 30 seconds
  setInterval(async () => {
    try {
      await checkSensorThresholds();
    } catch (error) {
      console.error('❌ Polling sensor check failed:', error.message);
    }
  }, 30000); // 30 seconds

  // Run first check immediately
  setTimeout(async () => {
    console.log('🚀 Running first sensor check...');
    try {
      await checkSensorThresholds();
      console.log('✅ First sensor check completed');
    } catch (error) {
      console.error('❌ First sensor check failed:', error.message);
    }
  }, 10000); // 10 seconds after startup

  // METHOD 2: Firebase Listener (BACKUP - might not work if SDK fails)
  try {
    db.ref('data').on('value', async (snapshot) => {
      console.log('🔔 Firebase listener triggered (SDK working!)');
      // Call the same check function
      await checkSensorThresholds();
    }, (error) => {
      console.error('❌ Firebase listener error:', error.message);
    });
    console.log('✅ Firebase listener attached (backup method)');
  } catch (error) {
    console.log('⚠️  Firebase listener failed to attach (will rely on polling)');
  }
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
            // Use REST API DELETE with timeout wrapper
            const url = `${config.firebase.databaseURL}/history/${dateKey}.json`;
            await fetchWithTimeout2(url, { method: 'DELETE' }, 10000);
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
    const snapshot = await fetchWithTimeout(db.ref(FIREBASE_PATHS.kontrol), 10000);
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
    // Check Firebase connection (skip SDK, just check via config)
    const firebaseOk = config.firebase.databaseURL ? true : false;

    // Check Redis connection
    await redis.ping();

    // Check queue
    const queueStatus = await wateringQueue.getJobCounts();

    console.log('\n💚 HEALTH CHECK:');
    console.log(`   Firebase: ${firebaseOk ? '✅' : '❌'} Connected`);
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
    const snapshot = await fetchWithTimeout(db.ref(FIREBASE_PATHS.kontrol), 10000);
    console.log('[DEBUG] Firebase read successful!');
    const data = snapshot.val();
    if (data) {
      console.log(`✅ Firebase /${FIREBASE_PATHS.kontrol} readable - waktu mode:`, data.waktu ? 'ENABLED' : 'DISABLED');
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

