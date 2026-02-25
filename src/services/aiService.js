/**
 * AI service — OpenAI via backend proxy (avoids browser connection errors).
 * API key is configured on the server (.env: REACT_APP_OPENAI_API_KEY or OPENAI_API_KEY).
 */

import {
  streamChat as openaiStreamChat,
  chatWithCsvTools as openaiChatWithCsvTools,
  chatWithYoutubeTools as openaiChatWithYoutubeTools,
  generateImage as openaiGenerateImage,
  CODE_KEYWORDS,
} from './openai';

export { CODE_KEYWORDS };

export const streamChat = async function* (history, newMessage, imageParts = [], useCodeExecution = false) {
  yield* openaiStreamChat(history, newMessage, imageParts, useCodeExecution);
};

export const chatWithCsvTools = async (history, newMessage, csvHeaders, executeFn) => {
  return openaiChatWithCsvTools(history, newMessage, csvHeaders, executeFn);
};

export const chatWithYoutubeTools = async (history, newMessage, channelData, executeFn) => {
  return openaiChatWithYoutubeTools(history, newMessage, channelData, executeFn);
};

export const generateImage = async (prompt, anchorImage) => {
  return openaiGenerateImage(prompt, anchorImage);
};
