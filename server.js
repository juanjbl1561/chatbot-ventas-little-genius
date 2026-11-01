// Servidor del chatbot vendedor por WhatsApp (Little Genius, Bolivia).
// Webhook de WhatsApp Cloud API (Meta) -> respuestas con Google Gemini -> WhatsApp.
//
// Cobro en Bolivia: MANUAL (dLocal Go quedó descartado el 1-nov-2026).
// El bot da las instrucciones de pago (QR/transferencia); cuando el cliente
// avisa que pagó, el dueño confirma con un mensaje y el bot envía el PDF solo.
//
// Variables de entorno necesarias (ver .env.example):
//   GEMINI_API_KEY, WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN,
//   ADMIN_PHONE_NUMBER, DELIVERY_URL_59, DELIVERY_URL_79

const express = require('express');
const { SYSTEM_PROMPT } = require('./system-prompt');

const app = express();
app.use(express.json());

const {
  GEMINI_API_KEY,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  ADMIN_PHONE_NUMBER,
  DELIVERY_URL_59,
  DELIVERY_URL_79,
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
// Órdenes pendientes de verificación de pago: número del cliente -> { pack }.
// Solo informativo: la orden que vale es el comando PAGADO del admin (la
// memoria de Vercel serverless puede perderse entre ejecuciones).
// ---------------------------------------------------------------------------
const pendingOrders = new Map();
const ORDER_MARKER = /\[ORDEN:(59|79)\]\s*$/;

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

      // El número del dueño es admin: sus mensajes son comandos, nunca chat de venta.
      if (ADMIN_PHONE_NUMBER && from === ADMIN_PHONE_NUMBER) {
        if (msg.type === 'text' && msg.text?.body) {
          await handleAdminMessage(msg.text.body.trim());
        }
        return;
      }

      if (msg.type === 'text' && msg.text?.body) {
        const userText = msg.text.body.trim();
        if (!userText) return;
        pushHistory(from, 'user', userText);

        let reply = await askGemini(from);

        // Si el bot dio instrucciones de pago, dejó la marca [ORDEN:59|79]:
        // se quita antes de enviar, se guarda la orden y se avisa al dueño.
        const orderMatch = reply.match(ORDER_MARKER);
        if (orderMatch) {
          reply = reply.replace(ORDER_MARKER, '').trim();
          pendingOrders.set(from, { pack: orderMatch[1], ts: Date.now() });
          await notifyAdminNewOrder(from, orderMatch[1]);
        }

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

// ---------------------------------------------------------------------------
// Comandos del dueño (mensajes desde ADMIN_PHONE_NUMBER).
//   PAGADO <número> <59|79>  -> envía el producto al cliente automáticamente
//   PENDIENTES               -> lista las órdenes pendientes de verificación
// ---------------------------------------------------------------------------
async function handleAdminMessage(text) {
  const pagado = text.match(/^pagado\s+(\d+)\s+(59|79)$/i);
  if (pagado) {
    const [, phone, pack] = pagado;
    const ok = await deliverToCustomer(phone, pack);
    if (ok) {
      pendingOrders.delete(phone);
      await sendWhatsApp(ADMIN_PHONE_NUMBER, `✅ Acceso enviado a ${phone} (Pack Bs ${pack}).`);
    } else {
      await sendWhatsApp(
        ADMIN_PHONE_NUMBER,
        '⚠️ No pude enviar el documento. Revisá que el link de entrega (DELIVERY_URL_' +
          pack + ') esté cargado en las variables de Vercel.'
      );
    }
    return;
  }

  if (/^pendientes$/i.test(text)) {
    if (pendingOrders.size === 0) {
      await sendWhatsApp(ADMIN_PHONE_NUMBER, 'No hay pagos pendientes de verificación.');
    } else {
      const lines = [...pendingOrders.entries()].map(
        ([phone, o]) => `• ${phone} — Pack Bs ${o.pack}`
      );
      await sendWhatsApp(ADMIN_PHONE_NUMBER, '🔔 Pagos por verificar:\n' + lines.join('\n'));
    }
    return;
  }

  await sendWhatsApp(
    ADMIN_PHONE_NUMBER,
    'Comandos:\n• PAGADO <número> <59|79> — libera el producto al cliente\n• PENDIENTES — muestra los pagos por verificar'
  );
}

// Avisa al dueño cuando un cliente recibe instrucciones de pago.
async function notifyAdminNewOrder(phone, pack) {
  if (!ADMIN_PHONE_NUMBER) return;
  await sendWhatsApp(
    ADMIN_PHONE_NUMBER,
    `🔔 Pago por verificar\nCliente: ${phone}\nPack: Bs ${pack}\n` +
      `Cuando el dinero llegue a tu cuenta, respondeme:\nPAGADO ${phone} ${pack}`
  );
}

// Entrega automática del producto: primero intenta enviar el PDF como
// documento de WhatsApp; si falla, manda el link como mensaje de texto.
async function deliverToCustomer(phone, pack) {
  const url = pack === '79' ? DELIVERY_URL_79 : DELIVERY_URL_59;
  if (!url) {
    console.error('Falta DELIVERY_URL_' + pack);
    return false;
  }

  const caption =
    `🎉 ¡Pago confirmado! Acá está tu acceso a Little Genius (Pack Bs ${pack}):\n\n` +
    `Se abre en el navegador (en iPhone, abrilo en Safari). ¡A disfrutar! 🚀`;

  const sent = await sendWhatsAppDocument(phone, url, `Little-Genius-Pack-${pack}.pdf`, caption);
  if (sent) return true;

  // Fallback: link como mensaje de texto.
  await sendWhatsApp(phone, caption.replace(': ', ':\n') + '\n\n' + url);
  return true;
}

// Envía un documento (el PDF desde Google Drive) por WhatsApp Cloud API.
// Devuelve true si Meta lo aceptó.
async function sendWhatsAppDocument(to, link, filename, caption) {
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
        type: 'document',
        document: { link, filename, caption },
      }),
    }
  );

  if (!resp.ok) {
    const detail = await resp.text();
    console.error('Error enviando documento:', resp.status, detail);
    return false;
  }
  return true;
}

// Arranque local: en Vercel se exporta la app en vez de escuchar.
if (require.main === module) {
  app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));
}

module.exports = app;
