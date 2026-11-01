// Servidor del chatbot vendedor por WhatsApp (Little Genius, Bolivia).
// Webhook de WhatsApp Cloud API (Meta) -> respuestas con Google Gemini -> WhatsApp.
//
// Variables de entorno necesarias (ver .env.example):
//   GEMINI_API_KEY, WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN

const express = require('express');
const { SYSTEM_PROMPT } = require('./system-prompt');

const app = express();
app.use(express.json());

const {
  GEMINI_API_KEY,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  PORT = 3000,
} = process.env;

// ---------------------------------------------------------------------------
// Memoria de conversación por número de teléfono (últimos 10 mensajes).
// NOTA: en producción conviene una base de datos (p. ej. Supabase, Redis o
// Firestore) para no perder el historial si el servidor se reinicia o escala.
// ---------------------------------------------------------------------------
const conversations = new Map();
const MAX_HISTORY = 10; // 5 intercambios (usuario + bot)

function getHistory(phone) {
  if (!conversations.has(phone)) conversations.set(phone, []);
  return conversations.get(phone);
}

function pushHistory(phone, role, text) {
  const history = getHistory(phone);
  history.push({ role, text });
  while (history.length > MAX_HISTORY) history.shift();
}

// ---------------------------------------------------------------------------
// GET / — chequeo rápido de que el servidor está vivo.
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.status(200).send('Chatbot Little Genius activo');
});

// ---------------------------------------------------------------------------
// GET /webhook — verificación que hace Meta al configurar el webhook.
// Meta envía: hub.mode=subscribe, hub.verify_token y hub.challenge.
// Si el token coincide con VERIFY_TOKEN, se devuelve el challenge.
// ---------------------------------------------------------------------------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado por Meta');
    return res.status(200).send(challenge);
  }
  console.warn('Verificación de webhook rechazada');
  return res.sendStatus(403);
});

// ---------------------------------------------------------------------------
// POST /webhook — mensajes entrantes de WhatsApp.
// Se responde 200 de inmediato a Meta y se procesa en segundo plano.
// ---------------------------------------------------------------------------
app.post('/webhook', (req, res) => {
  res.sendStatus(200);

  (async () => {
    try {
      const value = req.body?.entry?.[0]?.changes?.[0]?.value;
      const messages = value?.messages;
      if (!messages || messages.length === 0) return; // p. ej. notificaciones de estado

      const msg = messages[0];
      const from = msg.from; // número del cliente, formato internacional sin "+"

      if (msg.type === 'text' && msg.text?.body) {
        const userText = msg.text.body.trim();
        if (!userText) return;
        pushHistory(from, 'user', userText);

        const reply = await askGemini(from);
        pushHistory(from, 'model', reply);
        await sendWhatsApp(from, reply);
      } else {
        // Audios, imágenes, stickers, etc.: respuesta amable pidiendo texto.
        await sendWhatsApp(
          from,
          'Por ahora solo puedo leer mensajes de texto. ¿Me lo escribís por acá?'
        );
      }
    } catch (err) {
      console.error('Error procesando webhook:', err.message);
    }
  })();
});

// ---------------------------------------------------------------------------
// Llama a Gemini (REST, nivel gratuito) con el system prompt + historial.
// Si falla, devuelve un mensaje de respaldo amable en español con voseo.
// ---------------------------------------------------------------------------
async function askGemini(phone) {
  const history = getHistory(phone);

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: history.map((m) => ({
            role: m.role, // "user" o "model"
            parts: [{ text: m.text }],
          })),
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 300, // respuestas cortas estilo WhatsApp
          },
        }),
      }
    );

    if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}`);

    const data = await resp.json();
    const text = (data?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || '')
      .join('')
      .trim();

    if (!text) throw new Error('Respuesta vacía de Gemini');
    return text.slice(0, 4000); // límite seguro para WhatsApp
  } catch (err) {
    console.error('Error con Gemini:', err.message);
    return 'Perdón, se me cortó un momento la conexión. ¿Me repetís tu mensaje?';
  }
}

// ---------------------------------------------------------------------------
// Envía un mensaje de texto por WhatsApp Cloud API.
// ---------------------------------------------------------------------------
async function sendWhatsApp(to, text) {
  const resp = await fetch(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    }
  );

  if (!resp.ok) {
    const detail = await resp.text();
    console.error('Error enviando por WhatsApp:', resp.status, detail);
  }
}

// Arranque local: en Vercel se exporta la app en vez de escuchar.
if (require.main === module) {
  app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));
}

module.exports = app;
