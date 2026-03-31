const express = require('express');
const app = express();
app.use(express.json());

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const VERIFY_TOKEN = 'visioprobot2025';

const VIVI_PROMPT = `Você é a Vivi, assistente virtual da VisioPro Marketing — agência especializada em conteúdo com IA, vídeos gerados por inteligência artificial, influenciadores digitais e campanhas para negócios brasileiros.

Seu papel é atuar como consultora de marketing digital: entender o negócio do cliente, identificar suas necessidades, apresentar as soluções da VisioPro de forma estratégica e — sempre que possível — agendar uma reunião com a equipe.

TOM E ESTILO:
- Consultivo, especialista e acolhedor
- Linguagem profissional, mas acessível
- Use emojis com moderação
- Respostas curtas e objetivas — estamos no WhatsApp
- Nunca seja genérico: adapte sempre a resposta ao contexto do cliente

SOLUÇÕES DA VISIOPRO:
1. Vídeos com IA (Veo 3 / Sora / Hailuo) — para lançamentos, promoções, campanhas
2. Influenciadores Digitais IA — personagem exclusivo para a marca
3. Campanhas para Redes Sociais — Instagram, TikTok, YouTube Shorts
4. Campanhas Temáticas e Sazonais — datas comemorativas e lançamentos

FLUXO:
1. Se for primeira mensagem: apresente-se e pergunte sobre o negócio do cliente
2. Qualifique: tipo de negócio, desafio atual, plataformas que usa
3. Apresente no máximo 2-3 soluções relevantes
4. Conduza para agendamento de análise gratuita

OBJEÇÕES:
- "Já tenho agência": destaque o diferencial de IA e custo-benefício
- "É caro?": mencione análise gratuita para mostrar custo-benefício real
- "Vou pensar": respeite e ofereça enviar material

REGRAS:
- Nunca invente preços ou prazos
- Máximo 2 perguntas por mensagem
- Sempre em português brasileiro
- Não revele que é bot a menos que perguntado diretamente`;

const conversationHistory = {};

async function sendWhatsAppMessage(phoneNumberId, to, text) {
  const response = await fetch(
    `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text }
      })
    }
  );
  const data = await response.json();
  console.log('Mensagem enviada:', data.messages?.[0]?.id ? '✅ OK' : '❌ Erro', JSON.stringify(data));
  return data;
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado com sucesso!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') {
      return res.sendStatus(404);
    }

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message || message.type !== 'text') {
      return res.sendStatus(200);
    }

    const userPhone = message.from;
    const userText = message.text.body;
    const phoneNumberId = value.metadata.phone_number_id;

    console.log(`Mensagem recebida de ${userPhone}: ${userText}`);

    // ✅ Salva lead no Supabase
    await supabase.from('vivi_leads').upsert(
      { whatsapp: userPhone, status: 'em_conversa' },
      { onConflict: 'whatsapp' }
    );

    if (!conversationHistory[userPhone]) {
      conversationHistory[userPhone] = [];
    }

    conversationHistory[userPhone].push({
      role: 'user',
      parts: [{ text: userText }]
    });

    if (conversationHistory[userPhone].length > 20) {
      conversationHistory[userPhone] = conversationHistory[userPhone].slice(-20);
    }

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: VIVI_PROMPT }]
          },
          contents: conversationHistory[userPhone],
          generationConfig: {
            temperature: 0.8,
            maxOutputTokens: 500
          }
        })
      }
    );

    const geminiData = await geminiResponse.json();

    if (geminiData.error) {
      const errorCode = geminiData.error.code;
      console.error('Erro Gemini:', JSON.stringify(geminiData.error));

      if (errorCode === 429) {
        await sendWhatsAppMessage(phoneNumberId, userPhone, '⏳ Estou com muitas conversas agora! Por favor, tente novamente em alguns minutos. 😊');
      } else {
        await sendWhatsAppMessage(phoneNumberId, userPhone, '😕 Ocorreu um erro interno. Tente novamente em instantes!');
      }
      return res.sendStatus(200);
    }

    const botReply = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!botReply) {
      console.error('Resposta vazia do Gemini:', JSON.stringify(geminiData));
      await sendWhatsAppMessage(phoneNumberId, userPhone, '😕 Não consegui processar sua mensagem. Pode repetir?');
      return res.sendStatus(200);
    }

    conversationHistory[userPhone].push({
      role: 'model',
      parts: [{ text: botReply }]
    });

    await sendWhatsAppMessage(phoneNumberId, userPhone, botReply);

    res.sendStatus(200);
  } catch (error) {
    console.error('Erro no webhook:', error);
    res.sendStatus(500);
  }
});

app.get('/', (req, res) => {
  res.send('🤖 VisioPro Bot (Vivi) está rodando!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Bot da Vivi rodando na porta ${PORT}`);
});
