'use strict';

const AI_TOOLS = [
  { name: 'ChatGPT',      patterns: ['chat.openai.com', 'chatgpt.com'] },
  { name: 'Claude',       patterns: ['claude.ai', 'anthropic.com'] },
  { name: 'Gemini',       patterns: ['gemini.google.com', 'bard.google.com'] },
  { name: 'Copilot',      patterns: ['copilot.microsoft.com', 'bing.com/chat'] },
  { name: 'Perplexity',   patterns: ['perplexity.ai'] },
  { name: 'You.com',      patterns: ['you.com'] },
  { name: 'Phind',        patterns: ['phind.com'] },
  { name: 'Blackbox AI',  patterns: ['blackbox.ai'] },
];

/**
 * Check a URL against the known AI tool patterns.
 * @param {string} url
 * @returns {{ detected: boolean, tool: string|null }}
 */
function detectAITool(url) {
  if (!url || typeof url !== 'string') {
    return { detected: false, tool: null };
  }

  const normalised = url.toLowerCase();
  for (const tool of AI_TOOLS) {
    for (const pattern of tool.patterns) {
      if (normalised.includes(pattern)) {
        return { detected: true, tool: tool.name };
      }
    }
  }
  return { detected: false, tool: null };
}

module.exports = { AI_TOOLS, detectAITool };
