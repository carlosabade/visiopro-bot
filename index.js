const express = require('express');
const app = express();
app.use(express.json());

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'visioprobot2025';
const INBOX_URL = process.env.INBOX_URL || 'https://visiopro-inbox-backend-production.up.railway.app';
const GEMINI_KEY = process.env.GEMINI_API_KEY;

// ─── PROMPT TURBINADO ─────────────────────────────────────────────────────────

const VIVI_PROMPT = `Você é a Vivi, assistente consultora de negócios da VisioPro — agência de tecnologia e marketing digital especializada em inteligência artificial, com sede em Vitória da Conquista, Bahia.

TOM E ESTILO:
- Consultiva, especialista e acolhedora
- Linguagem profissional mas descontraída — estamos no WhatsApp
- Use emojis com moderação (1-2 por mensagem no máximo)
- Respostas curtas e objetivas (máximo 3 parágrafos)
- Nunca seja genérica: adapte sempre ao contexto do cliente
- Nunca invente preços, prazos ou promessas que a empresa não fez

SERVIÇOS DA VISIOPRO:
1. 🤖 Bots de Atendimento WhatsApp — bots inteligentes com IA que vendem e atendem 24h/7 dias, integrados ao WhatsApp Business
2. 📱 Aplicativos Mobile e Web — apps personalizados para gestão, vendas, agendamentos e sistemas internos
3. 🎬 Vídeos com IA (Veo 3 / Sora / Hailuo) — vídeos profissionais gerados por IA para campanhas, lançamentos e promoções
4. 👤 Influenciadores Digitais IA — personagem de IA exclusivo para a marca, com rosto e voz próprios
5. 📊 Campanhas para Redes Sociais — Instagram, TikTok, YouTube Shorts com conteúdo gerado por IA
6. ⚙️ Automações e Sistemas — automação de processos, integrações entre sistemas, ERPs e CRMs personalizados
7. 🌐 Sites e Landing Pages — sites modernos, rápidos e otimizados para conversão

DIFERENCIAIS:
- Empresa local (Bahia) com atendimento humanizado
- Combinação única de tecnologia + criatividade + IA
- Projetos entregues com suporte pós-lançamento
- Experiência com negócios de todos os portes

FLUXO DA CONVERSA:
1. Primeira mensagem: apresente-se brevemente e pergunte o nome e o tipo de negócio do cliente
2. Qualifique: entenda o desafio atual, o que já usa, o que quer melhorar
3. Apresente no máximo 2-3 soluções mais relevantes para o caso
4. Conduza para agendamento de uma análise gratuita com a equipe

CLASSIFICAÇÃO DE SETOR (use internamente para direcionar):
- "vendas" → cliente quer orçamento, preços, fechar negócio
- "desenvolvimento" → quer bot, app, sistema, automação, site
- "marketing" → quer vídeo IA, influenciador IA, campanha, redes sociais
- "suporte" → tem problema, dúvida técnica, é cliente atual

COMO TRATAR OBJEÇÕES:
- "Já tenho agência": destaque o diferencial da IA e custo-benefício
- "É caro?": mencione que fazemos análise gratuita primeiro
- "Vou pensar": respeite e ofereça enviar material por aqui mesmo
- "Não tenho tempo": mostre que a IA trabalha enquanto o cliente descansa

REGRAS:
- Máximo 2 perguntas por mensagem
- Sempre em português brasileiro
- Não revele que é bot a menos que perguntado diretamente
- Se o cliente perguntar se é IA/bot, seja honesta mas simpática
- Quando identificar nome do cliente, use-o nas respostas seguintes`;

// ─── CLASSIFICADOR DE SETOR ───────────────────────────────────────────────────

async function classificarSetor(historico) {
  try {
    const mensagens = historico.map(m => `${m.role === 'user' ? 'Cliente' : 'Vivi'}: ${m.parts[0].text}`).join('\n');
    
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{ text: `Analise essa conversa de WhatsApp e responda APENAS com uma palavra: vendas, desenvolvimento, marketing ou suporte.\n\nConversa:\n${mensagens}\n\nSetor:` }]
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 10 }
        })
      }
    );

    const data = await res.json();
    const setor = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toLowerCase();
    const setoresValidos = ['vendas', 'desenvolvimento', 'marketing', 'suporte'];
    return setoresValidos.includes(setor) ? setor : 'vendas';
  } catch(e) {
    console.error('[SETOR]', e.message);
    return 'vendas';
  }
}

// ─── EXTRATOR DE NOME ─────────────────────────────────────────────────────────

async function extrairNome(historico) {
  try {
    const mensagensUser = historico.filter(m => m.role === 'user').map(m => m.parts[0].text).join(' ');
    
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{ text: `Nas mensagens abaixo, o cliente mencionou seu nome? Se sim, responda APENAS com o primeiro nome. Se não, responda APENAS com a palavra "null".\n\nMensagens: ${mensagensUser}\n\nNome:` }]
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 20 }
        })
      }
    );

    const data = await res.json();
    const nome = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return (nome && nome !== 'null' && nome.length < 50) ? nome : null;
  } catch(e) {
    return null;
  }
}

// ─── HISTÓRICO NO SUPABASE ────────────────────────────────────────────────────

async function carregarHistorico(numero) {
  try {
    const { data } = await supabase
      .from('vivi_conversas')
      .select('role, mensagem')
      .eq('session_id', `wa_${numero}`)
      .order('criado_em', { ascending: true })
      .limit(20);

    if (!data || data.length === 0) return [];

    return data.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.mensagem }]
    }));
  } catch(e) {
    console.error('[HISTÓRICO]', e.message);
    return [];
  }
}

async function salvarMensagem(numero, role, texto, nome) {
  try {
    await supabase.from('vivi_conversas').insert({
      session_id: `wa_${numero}`,
      role: role === 'model' ? 'assistant' : 'user',
      mensagem: texto,
      nome: nome || null,
      canal: 'whatsapp'
    });
  } catch(e) {
    console.error('[SALVAR MSG]', e.message);
  }
}

// ─── NOTIFICAR INBOX ──────────────────────────────────────────────────────────

async function notificarInbox(numero, texto, tipo, nome) {
  try {
    await fetch(`${INBOX_URL}/inbox/mensagem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numero, texto, tipo, nome })
    });
  } catch(e) {
    console.error('[INBOX]', e.message);
  }
}

// ─── WHATSAPP ─────────────────────────────────────────────────────────────────

async function sendWhatsAppMessage(phoneNumberId, to, text) {
  try {
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
    console.log(`[WA] Enviado para ${to}:`, data.messages?.[0]?.id ? '✅' : '❌');
    return data;
  } catch(e) {
    console.error('[WA ERROR]', e.message);
  }
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde imediatamente

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const phoneNumberId = body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    const profileName = body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name;

    if (!message || message.type !== 'text') return;

    const userPhone = message.from;
    const userText = message.text.body;

    console.log(`[MSG] ${profileName || userPhone}: ${userText}`);

    // Carrega histórico do Supabase
    const historico = await carregarHistorico(userPhone);
    const nomeAtual = historico.find(m => m.role === 'user')?.parts?.[0]?.text ? null : profileName;

    // Salva mensagem do usuário
    await salvarMensagem(userPhone, 'user', userText, profileName);

    // Notifica inbox (mensagem recebida)
    await notificarInbox(userPhone, userText, 'recebida', profileName || userPhone);

    // Adiciona ao histórico local
    historico.push({ role: 'user', parts: [{ text: userText }] });

    // Chama Gemini
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: VIVI_PROMPT }] },
          contents: historico,
          generationConfig: { temperature: 0.8, maxOutputTokens: 500 }
        })
      }
    );

    const geminiData = await geminiResponse.json();

    if (geminiData.error) {
      console.error('[GEMINI ERROR]', geminiData.error);
      if (geminiData.error.code === 429) {
        await sendWhatsAppMessage(phoneNumberId, userPhone, '⏳ Estou com muitas conversas agora! Tente novamente em alguns minutos. 😊');
      } else {
        await sendWhatsAppMessage(phoneNumberId, userPhone, '😕 Ocorreu um erro. Pode repetir sua mensagem?');
      }
      return;
    }

    const botReply = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!botReply) return;

    // Salva resposta do bot
    await salvarMensagem(userPhone, 'model', botReply, null);

    // Notifica inbox (mensagem do bot)
    await notificarInbox(userPhone, botReply, 'bot', profileName || userPhone);

    // A cada 5 mensagens, classifica setor e extrai nome
    historico.push({ role: 'model', parts: [{ text: botReply }] });
    if (historico.length % 5 === 0) {
      const [setor, nome] = await Promise.all([
        classificarSetor(historico),
        extrairNome(historico)
      ]);

      // Atualiza setor no inbox
      try {
        await fetch(`${INBOX_URL}/inbox/conversas/${userPhone}/setor`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ setor })
        });
        console.log(`[SETOR] ${profileName || userPhone} → ${setor}`);
      } catch(e) {}

      // Atualiza lead no Supabase com nome e setor
      if (nome || setor) {
        await supabase.from('vivi_leads').upsert({
          whatsapp: userPhone,
          nome: nome || profileName || userPhone,
          status: 'em_conversa',
          setor,
          atualizado_em: new Date().toISOString()
        }, { onConflict: 'whatsapp' });
      }
    } else {
      // Upsert básico do lead
      await supabase.from('vivi_leads').upsert({
        whatsapp: userPhone,
        nome: profileName || userPhone,
        status: 'em_conversa',
        atualizado_em: new Date().toISOString()
      }, { onConflict: 'whatsapp' });
    }

    // Envia resposta ao cliente
    await sendWhatsAppMessage(phoneNumberId, userPhone, botReply);

  } catch (error) {
    console.error('[WEBHOOK ERROR]', error);
  }
});

app.get('/', (req, res) => {
  res.json({ status: '🤖 VisioPro Bot (Vivi) rodando!', version: '2.0' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Vivi Bot v2.0 rodando na porta ${PORT}`);
});
