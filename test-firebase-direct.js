/**
 * Test koneksi Firebase langsung dengan credentials
 * Untuk memverifikasi Railway Worker bisa akses Firebase
 */

require('dotenv').config();
const admin = require('firebase-admin');

console.log('🔍 Testing Firebase Connection...\n');

// Check environment variables
console.log('1. Checking Environment Variables:');
const requiredVars = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_DATABASE_URL'];
let allPresent = true;

requiredVars.forEach(varName => {
  const exists = !!process.env[varName];
  console.log(`   ${exists ? '✅' : '❌'} ${varName}: ${exists ? 'Set' : 'MISSING'}`);
  if (!exists) allPresent = false;
});

if (!allPresent) {
  console.error('\n❌ Missing environment variables!');
  console.error('📋 Create a .env file with:');
  console.error('   FIREBASE_PROJECT_ID=project-ta-951b4');
  console.error('   FIREBASE_CLIENT_EMAIL=your-service-account@project-ta-951b4.iam.gserviceaccount.com');
  console.error('   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n"');
  console.error('   FIREBASE_DATABASE_URL=https://project-ta-951b4-default-rtdb.firebaseio.com');
  process.exit(1);
}

async function testFirebase() {
  try {
    console.log('\n2. Initializing Firebase Admin SDK...');
    
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
    
    console.log('✅ Firebase Admin SDK initialized');
    
    const db = admin.database();
    
    console.log('\n3. Testing Firebase Read Permission...');
    const snapshot = await db.ref('kontrol').once('value');
    const kontrolData = snapshot.val();
    
    if (!kontrolData) {
      console.error('❌ No data in /kontrol node!');
      console.error('   Make sure Flutter app has saved schedule configuration.');
      process.exit(1);
    }
    
    console.log('✅ Successfully read /kontrol data:');
    console.log(JSON.stringify(kontrolData, null, 2));
    
    console.log('\n4. Validating Schedule Configuration...');
    
    const issues = [];
    
    if (kontrolData.waktu !== true) {
      issues.push('❌ waktu mode is disabled (waktu: false)');
    } else {
      console.log('✅ Waktu mode is ENABLED');
    }
    
    if (!kontrolData.waktu_1 && !kontrolData.waktu_2) {
      issues.push('❌ No schedule times configured (waktu_1 and waktu_2 missing)');
    } else {
      console.log(`✅ Jadwal 1: ${kontrolData.waktu_1 || 'Not set'}`);
      console.log(`✅ Jadwal 2: ${kontrolData.waktu_2 || 'Not set'}`);
    }
    
    if (!kontrolData.durasi_1 && !kontrolData.durasi_2) {
      issues.push('⚠️  No duration configured');
    } else {
      console.log(`✅ Durasi 1: ${kontrolData.durasi_1 || 0} seconds`);
      console.log(`✅ Durasi 2: ${kontrolData.durasi_2 || 0} seconds`);
    }
    
    console.log('\n5. Current Time vs Schedule:');
    const now = new Date();
    const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    console.log(`⏰ Current time: ${currentTime} (${now.toLocaleString('id-ID', {timeZone: 'Asia/Jakarta'})})`);
    
    if (kontrolData.waktu_1 === currentTime) {
      console.log('🎯 MATCH! Jadwal 1 should trigger NOW!');
    } else if (kontrolData.waktu_2 === currentTime) {
      console.log('🎯 MATCH! Jadwal 2 should trigger NOW!');
    } else {
      console.log(`⏳ No match. Next schedule:`);
      if (kontrolData.waktu_1) console.log(`   - Jadwal 1 at ${kontrolData.waktu_1}`);
      if (kontrolData.waktu_2) console.log(`   - Jadwal 2 at ${kontrolData.waktu_2}`);
    }
    
    console.log('\n6. Testing Firebase Write Permission...');
    await db.ref('_test_worker').set({
      timestamp: Date.now(),
      message: 'Railway Worker test write',
      from: 'test-firebase-direct.js'
    });
    console.log('✅ Successfully wrote test data to Firebase');
    
    // Cleanup
    await db.ref('_test_worker').remove();
    console.log('✅ Test data cleaned up');
    
    if (issues.length > 0) {
      console.log('\n⚠️  Configuration Issues Found:');
      issues.forEach(issue => console.log(`   ${issue}`));
    } else {
      console.log('\n✅ All checks passed! Configuration looks good.');
      console.log('\n📋 Next Steps:');
      console.log('   1. Deploy Railway Worker with these same credentials');
      console.log('   2. Check Railway logs for confirmation');
      console.log('   3. Worker should trigger at scheduled times');
    }
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    
    if (error.code === 'auth/invalid-credential') {
      console.error('\n💡 Fix: Check your Firebase Service Account credentials');
      console.error('   1. Go to Firebase Console → Project Settings → Service Accounts');
      console.error('   2. Generate new private key');
      console.error('   3. Update .env file with new credentials');
    } else if (error.message.includes('PERMISSION_DENIED')) {
      console.error('\n💡 Fix: Check Firebase Realtime Database Rules');
      console.error('   1. Go to Firebase Console → Realtime Database → Rules');
      console.error('   2. Make sure service account has read/write access');
    }
    
    process.exit(1);
  } finally {
    if (admin.apps.length > 0) {
      await admin.app().delete();
    }
  }
}

testFirebase();