/**
 * Debug Script untuk Railway Worker
 * Jalankan script ini untuk debugging masalah scheduling
 */

require('dotenv').config();
const admin = require('firebase-admin');

// Setup Firebase
const config = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
};

console.log('🔍 DEBUG: Railway Worker Troubleshooting');
console.log('==========================================');

async function debugWorker() {
  try {
    // Test Firebase connection
    console.log('1. Testing Firebase connection...');
    
    admin.initializeApp({
      credential: admin.credential.cert(config),
      databaseURL: config.databaseURL,
    });
    
    const db = admin.database();
    console.log('✅ Firebase initialized');

    // Test reading kontrol config
    console.log('\n2. Reading kontrol configuration...');
    const snapshot = await db.ref('kontrol').once('value');
    const kontrolConfig = snapshot.val();
    
    console.log('📊 Current kontrol config:', JSON.stringify(kontrolConfig, null, 2));
    
    // Check important fields
    console.log('\n3. Validating schedule configuration...');
    if (!kontrolConfig) {
      console.log('❌ No kontrol config found! Flutter app needs to set schedule first.');
      return;
    }
    
    const issues = [];
    
    if (!kontrolConfig.waktu) {
      issues.push('⚠️  waktu mode is disabled');
    }
    
    if (!kontrolConfig.waktu_1 && !kontrolConfig.waktu_2) {
      issues.push('❌ No jadwal waktu_1 or waktu_2 configured');
    }
    
    if (!kontrolConfig.durasi_1 && !kontrolConfig.durasi_2) {
      issues.push('❌ No durasi_1 or durasi_2 configured');
    }
    
    if (issues.length === 0) {
      console.log('✅ All configuration looks good!');
      
      // Test current time vs scheduled time
      console.log('\n4. Time check...');
      const now = new Date();
      const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
      console.log(`⏰ Current time: ${currentTime}`);
      console.log(`📅 Jadwal 1: ${kontrolConfig.waktu_1 || 'Not set'}`);
      console.log(`📅 Jadwal 2: ${kontrolConfig.waktu_2 || 'Not set'}`);
      
      if (kontrolConfig.waktu_1 === currentTime || kontrolConfig.waktu_2 === currentTime) {
        console.log('🎯 MATCHED! Schedule should trigger now');
      } else {
        console.log('⏳ No schedule match at current time');
      }
      
    } else {
      console.log('❌ Configuration issues found:');
      issues.forEach(issue => console.log(`   ${issue}`));
    }
    
    // Test Firebase write permission
    console.log('\n5. Testing Firebase write permission...');
    await db.ref('debug').set({
      timestamp: Date.now(),
      message: 'Railway Worker debug test'
    });
    console.log('✅ Firebase write permission OK');
    
    console.log('\n🎉 Debug completed!');
    
  } catch (error) {
    console.error('❌ Debug failed:', error.message);
    
    if (error.message.includes('private_key')) {
      console.error('\n💡 Fix: Check FIREBASE_PRIVATE_KEY format');
      console.error('   - Should start with "-----BEGIN PRIVATE KEY-----"');
      console.error('   - Should have \\n properly escaped');
      console.error('   - Should be wrapped in quotes');
    }
    
    if (error.message.includes('projectId')) {
      console.error('\n💡 Fix: Check FIREBASE_PROJECT_ID');
      console.error('   - Should match your Firebase project ID');
    }
  } finally {
    if (admin.apps.length > 0) {
      await admin.app().delete();
    }
    process.exit(0);
  }
}

debugWorker();