const textToSpeech = require('@google-cloud/text-to-speech');
const { Storage }   = require('@google-cloud/storage');
const crypto        = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Demo mode (D9): TTS generation disabled — seeded cards ship without
  // audio fields and user-created cards simply skip audio.
  if (process.env.DEMO_MODE === 'true') {
    return { statusCode: 403, body: 'Disabled in demo' };
  }

  let text;
  try {
    ({ text } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  if (!text || typeof text !== 'string' || !text.trim()) {
    return { statusCode: 400, body: 'Missing or empty text' };
  }

  const bucketName = process.env.GCP_TTS_BUCKET;
  if (!process.env.GCP_CLIENT_EMAIL || !process.env.GCP_PRIVATE_KEY || !bucketName) {
    return { statusCode: 500, body: 'Missing GCP configuration' };
  }

  const credentials = {
    type:                'service_account',
    project_id:          process.env.GCP_PROJECT_ID,
    private_key_id:      process.env.GCP_PRIVATE_KEY_ID,
    private_key:         process.env.GCP_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email:        process.env.GCP_CLIENT_EMAIL,
    token_uri:           'https://oauth2.googleapis.com/token',
  };

  const trimmed  = text.trim();
  const hash     = crypto.createHash('sha256').update(trimmed, 'utf8').digest('hex').slice(0, 16);
  const filePath = `tts/${hash}.mp3`;
  const publicUrl = `https://storage.googleapis.com/${bucketName}/${filePath}`;

  try {
    const storage = new Storage({ credentials });
    const file    = storage.bucket(bucketName).file(filePath);

    // Return immediately if already cached in GCS
    const [exists] = await file.exists();
    if (exists) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: publicUrl }),
      };
    }

    // Generate via GCP TTS
    const ttsClient  = new textToSpeech.TextToSpeechClient({ credentials });
    const [response] = await ttsClient.synthesizeSpeech({
      input:       { text: trimmed },
      // [LANG-SPECIFIC] TTS voice — change languageCode/name for another language (docs/08).
      voice:       { languageCode: 'ko-KR', name: 'ko-KR-Wavenet-A' },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0 },
    });

    // Upload to GCS with long-lived cache headers
    await file.save(response.audioContent, {
      metadata: {
        contentType:  'audio/mpeg',
        cacheControl: 'public, max-age=31536000',
      },
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: publicUrl }),
    };
  } catch (err) {
    console.error('TTS generation error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
