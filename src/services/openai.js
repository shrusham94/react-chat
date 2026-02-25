import { CSV_TOOL_DECLARATIONS } from './csvTools';
import { YOUTUBE_TOOL_DECLARATIONS } from './youtubeTools';

const API = process.env.REACT_APP_API_URL || '';

export const CODE_KEYWORDS = /\b(plot|chart|graph|analyz|statistic|regression|correlat|histogram|visualiz|calculat|compute|run code|write code|execute|pandas|numpy|matplotlib|csv|data)\b/i;

let cachedPrompt = null;

async function loadSystemPrompt() {
  if (cachedPrompt) return cachedPrompt;
  try {
    const res = await fetch('/prompt_chat.txt');
    cachedPrompt = res.ok ? (await res.text()).trim() : '';
  } catch {
    cachedPrompt = '';
  }
  return cachedPrompt;
}

// Convert Gemini tool declarations to OpenAI format
function toOpenAITools(declarations) {
  return declarations.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(d.parameters.properties || {}).map(([k, v]) => [
            k,
            { type: (v.type || 'string').toLowerCase(), description: v.description },
          ])
        ),
        required: d.parameters.required || [],
      },
    },
  }));
}

// Extract user name from message prefix [User: FirstName LastName]
function extractUserNameFromMessage(msg) {
  if (!msg || typeof msg !== 'string') return '';
  const m = msg.match(/^\[User:\s*([^\]]+)\]\s*\n\n/);
  return m ? m[1].trim() : '';
}

// Extract user name from chat history (user said "My name is X", "I'm X", etc.)
function extractUserNameFromHistory(history) {
  if (!history || !Array.isArray(history)) return '';
  const pattern = /(?:my name is|i'm|i am|call me|it's|i go by|you can call me|this is)\s+([a-zA-Z][a-zA-Z\s'-]{0,50})/i;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m?.role !== 'user' || !m.content) continue;
    const text = String(m.content).trim();
    const match = text.match(pattern);
    if (match) {
      const name = match[1].trim();
      if (name.length >= 2 && name.length <= 50) return name;
    }
  }
  return '';
}

// Build messages for OpenAI (system + history + new message)
function buildMessages(systemInstruction, history, newMessage, imageParts) {
  const messages = [];
  const userName = extractUserNameFromMessage(newMessage) || extractUserNameFromHistory(history);

  let systemContent = systemInstruction || '';
  if (userName) {
    systemContent = (systemContent ? systemContent + '\n\n' : '') +
      `The user you are speaking with is ${userName}. Always address them by name when appropriate throughout the conversation. Do not ask for their name - you already know it.`;
  } else {
    systemContent = (systemContent ? systemContent + '\n\n' : '') +
      `You do not know the user's name yet. In your response, ask for their name in a friendly, natural way (e.g. "What's your name?" or "I'd love to know your name!"). Once they tell you their name in a future message, remember it and use it when addressing them.`;
  }
  if (systemContent) {
    messages.push({
      role: 'system',
      content: `Follow these instructions in every response:\n\n${systemContent}`,
    });
  }

  history.forEach((m) => {
    messages.push({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content || '',
    });
  });

  const content = [];
  if (newMessage) content.push({ type: 'text', text: newMessage });
  imageParts.forEach((img) => {
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:${img.mimeType || 'image/png'};base64,${img.data}`,
      },
    });
  });

  messages.push({
    role: 'user',
    content: content.length === 1 && content[0].type === 'text' ? content[0].text : content,
  });

  return messages;
}

// Yields same shape for compatibility with Chat component:
//   { type: 'text', text }
//   { type: 'fullResponse', parts } — OpenAI has no code execution; yields text-only when applicable
//   { type: 'grounding', data } - OpenAI has no search; never yielded
export const streamChat = async function* (history, newMessage, imageParts = [], useCodeExecution = false) {
  const systemInstruction = await loadSystemPrompt();
  const messages = buildMessages(systemInstruction, history, newMessage, imageParts);

  const res = await fetch(`${API}/api/openai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, stream: true }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || res.statusText || 'Chat request failed');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'text' && parsed.text) yield { type: 'text', text: parsed.text };
        } catch (_) {}
      }
    }
  }
};

// Function-calling chat for CSV tools
export async function chatWithCsvTools(history, newMessage, csvHeaders, executeFn) {
  const systemInstruction = await loadSystemPrompt();
  const tools = toOpenAITools(CSV_TOOL_DECLARATIONS);

  const msgWithContext = csvHeaders?.length
    ? `[CSV columns: ${csvHeaders.join(', ')}]\n\n${newMessage}`
    : newMessage;

  const userName = extractUserNameFromMessage(newMessage) || extractUserNameFromHistory(history);
  let systemContent = systemInstruction || '';
  if (userName) {
    systemContent = (systemContent ? systemContent + '\n\n' : '') +
      `The user you are speaking with is ${userName}. Always address them by name when appropriate. Do not ask for their name - you already know it.`;
  } else {
    systemContent = (systemContent ? systemContent + '\n\n' : '') +
      `You do not know the user's name yet. Ask for their name in a friendly way. Once they tell you, remember and use it.`;
  }
  const baseMessages = [];
  if (systemContent) {
    baseMessages.push({
      role: 'system',
      content: `Follow these instructions in every response:\n\n${systemContent}`,
    });
  }
  history.forEach((m) => {
    baseMessages.push({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content || '',
    });
  });
  baseMessages.push({ role: 'user', content: msgWithContext });

  const charts = [];
  const toolCalls = [];
  let messages = [...baseMessages];

  for (let round = 0; round < 5; round++) {
    const res = await fetch(`${API}/api/openai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, stream: false, tools, tool_choice: 'auto' }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || res.statusText || 'Chat request failed');
    }
    const response = await res.json();
    const choice = response.choices?.[0];
    const msg = choice?.message;
    if (!msg) break;

    const content = msg.content;
    const toolCallsList = msg.tool_calls || [];

    if (toolCallsList.length === 0) {
      return { text: content || '', charts, toolCalls };
    }

    messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: toolCallsList,
    });

    for (const tc of toolCallsList) {
      const name = tc.function?.name;
      let args = {};
      try {
        args = JSON.parse(tc.function?.arguments || '{}');
      } catch {}
      const result = executeFn(name, args);
      toolCalls.push({ name, args, result });
      if (result?._chartType) charts.push(result);

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  return { text: '', charts, toolCalls };
};

// Generate image via DALL-E 3 (proxied through backend)
// anchorImageBase64: optional reference image (DALL-E 3 is text-only; we add context to prompt when anchor provided)
export async function generateImage(prompt, anchorImageBase64 = null) {
  const res = await fetch(`${API}/api/openai/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: prompt || 'A beautiful image',
      anchorImage: anchorImageBase64 || undefined,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || res.statusText || 'Image generation failed');
  }
  return await res.json();
}

// Function-calling chat for YouTube tools
export async function chatWithYoutubeTools(history, newMessage, channelData, executeFn, imageParts = []) {
  const systemInstruction = await loadSystemPrompt();
  const tools = toOpenAITools(YOUTUBE_TOOL_DECLARATIONS);
  const jsonPreview = channelData?.videos?.length
    ? `[YouTube channel JSON loaded: ${channelData.videos.length} videos. Fields: ${Object.keys(channelData.videos[0] || {}).join(', ')}]\n\n`
    : '';
  const msgWithContext = jsonPreview + newMessage;

  const userName = extractUserNameFromMessage(newMessage) || extractUserNameFromHistory(history);
  let systemContent = systemInstruction || '';
  if (userName) {
    systemContent = (systemContent ? systemContent + '\n\n' : '') +
      `The user you are speaking with is ${userName}. Always address them by name when appropriate. Do not ask for their name - you already know it.`;
  } else {
    systemContent = (systemContent ? systemContent + '\n\n' : '') +
      `You do not know the user's name yet. Ask for their name in a friendly way. Once they tell you, remember and use it.`;
  }
  const baseMessages = [];
  if (systemContent) {
    baseMessages.push({
      role: 'system',
      content: `Follow these instructions in every response:\n\n${systemContent}`,
    });
  }
  history.forEach((m) => {
    baseMessages.push({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content || '',
    });
  });
  // Do NOT include the image in the message — base64 images are ~1M+ tokens and exceed context limit.
  // The imagePrefix in msgWithContext tells the model to use generateImage with use_anchor: true.
  // The anchor is passed to generateImage when the tool runs.
  baseMessages.push({ role: 'user', content: msgWithContext });

  const charts = [];
  const toolCalls = [];
  let messages = [...baseMessages];

  for (let round = 0; round < 5; round++) {
    const res = await fetch(`${API}/api/openai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, stream: false, tools, tool_choice: 'auto' }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || res.statusText || 'Chat request failed');
    }
    const response = await res.json();
    const choice = response.choices?.[0];
    const msg = choice?.message;
    if (!msg) break;

    const content = msg.content;
    const toolCallsList = msg.tool_calls || [];

    if (toolCallsList.length === 0) {
      return { text: content || '', charts, toolCalls };
    }

    messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: toolCallsList,
    });

    for (const tc of toolCallsList) {
      const name = tc.function?.name;
      let args = {};
      try {
        args = JSON.parse(tc.function?.arguments || '{}');
      } catch {}
      const result = await Promise.resolve(executeFn(name, args));
      toolCalls.push({ name, args, result });
      if (result?._chartType) charts.push(result);

      // Sanitize result for API: strip base64 imageData to avoid 1M+ token blowup
      let contentForApi = result;
      if (result?._chartType === 'generated_image' && result.imageData) {
        contentForApi = {
          ...result,
          imageData: '[displayed above]',
          _note: 'The image is already displayed in the chat. Do not include any ![image] markdown in your response.',
        };
      }
      if (result?._chartType === 'play_video') {
        contentForApi = {
          ...result,
          _note: 'A clickable video card with the actual title and thumbnail is already displayed. Do NOT use placeholders like [First Video Title] or [Video Duration]. Do NOT say "click on the title above" - the card IS the clickable element. Keep your reply very brief (e.g. "Here it is!" or "Click the card to watch on YouTube.").',
        };
      }
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(contentForApi),
      });
    }
  }

  return { text: '', charts, toolCalls };
};
