/**
 * lib/dom-scraper.js
 * Scrapes claude.ai conversation turns from the live DOM.
 *
 * Returns an array of: { role: 'user'|'assistant', content: string, index: number }
 *
 * Strategy:
 *  Claude.ai renders conversation turns inside a scrollable container.
 *  We target the highest-confidence selectors and fall back gracefully.
 *  All HTML is stripped; code blocks are reconstructed with ``` fences.
 *  Images, file attachments, and empty turns are skipped.
 *
 * Exported as global: DomScraper
 */

'use strict';

const DomScraper = (() => {

  // ── Selector sets (ordered by specificity / confidence) ────────────────────

  /**
   * Selectors that identify an individual turn wrapper element.
   * We try each in order and use the first that returns results.
   */
  const TURN_SELECTORS = [
    // Claude's primary conversation structure (as of 2024-2025)
    '[data-testid="conversation-turn"]',
    '[class*="ConversationTurn"]',
    // Generic: a turn is a direct child of the chat content area
    '[class*="chat-messages"] > div',
    '[class*="Messages"] > div',
    // Broader fallback
    'main [class*="message"]',
    'main [class*="Message"]',
    'main article',
  ];

  /**
   * Within a turn, selectors that identify the role (user vs assistant).
   * We classify by looking for known role markers.
   */
  const USER_ROLE_MARKERS = [
    '[data-testid="user-message"]',
    '[class*="HumanTurn"]',
    '[class*="human-turn"]',
    '[class*="user-message"]',
    '[class*="UserMessage"]',
  ];

  const ASSISTANT_ROLE_MARKERS = [
    '[data-testid="assistant-message"]',
    '[class*="AITurn"]',
    '[class*="ai-turn"]',
    '[class*="AssistantMessage"]',
    '[class*="assistant-message"]',
    '[class*="BotMessage"]',
  ];

  // ── HTML → plain text converter ─────────────────────────────────────────────

  /**
   * Convert an HTML element's content to a clean markdown-ish string.
   * - <code> / <pre> blocks → fenced ``` blocks
   * - <p>, <li>, <br> → proper newlines
   * - <strong>/<b>, <em>/<i> → markdown bold/italic
   * - Strip all other tags
   * - Decode HTML entities
   * - Skip <img> elements entirely
   */
  function htmlToMarkdown(element) {
    if (!element) return '';

    // Clone to avoid mutating the live DOM
    const clone = element.cloneNode(true);

    // Remove hidden elements (e.g. copy buttons, action menus)
    clone.querySelectorAll(
      'button, [aria-hidden="true"], [class*="tooltip"], [class*="action"], ' +
      '[class*="copy"], [class*="feedback"], [data-testid*="button"], svg'
    ).forEach(el => el.remove());

    return nodeToMarkdown(clone).trim();
  }

  function nodeToMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();

    // ── Skip non-content elements ────────────────────────────────────────────
    if (['script', 'style', 'noscript', 'svg', 'img', 'button'].includes(tag)) {
      return '';
    }

    // ── Fenced code block ────────────────────────────────────────────────────
    if (tag === 'pre') {
      const codeEl = node.querySelector('code');
      const raw = codeEl ? codeEl.textContent : node.textContent;
      // Detect language from class (e.g. class="language-python")
      const langClass = (codeEl || node).className || '';
      const langMatch = langClass.match(/language-(\S+)/);
      const lang = langMatch ? langMatch[1] : '';
      return `\n\`\`\`${lang}\n${raw.trimEnd()}\n\`\`\`\n`;
    }

    // ── Inline code ──────────────────────────────────────────────────────────
    if (tag === 'code') {
      // Only inline if not inside a pre (already handled above)
      return `\`${node.textContent}\``;
    }

    // ── Headings ─────────────────────────────────────────────────────────────
    if (/^h[1-6]$/.test(tag)) {
      const level = parseInt(tag[1]);
      const prefix = '#'.repeat(level) + ' ';
      return `\n${prefix}${childrenToMarkdown(node)}\n`;
    }

    // ── Block elements ────────────────────────────────────────────────────────
    if (['p', 'div', 'section', 'article', 'blockquote'].includes(tag)) {
      const inner = childrenToMarkdown(node);
      if (!inner.trim()) return '';
      if (tag === 'blockquote') return `\n> ${inner.trim().replace(/\n/g, '\n> ')}\n`;
      return `\n${inner}\n`;
    }

    // ── List elements ─────────────────────────────────────────────────────────
    if (tag === 'ul') {
      return '\n' + Array.from(node.children).map(li =>
        `- ${nodeToMarkdown(li).trim()}`
      ).join('\n') + '\n';
    }
    if (tag === 'ol') {
      return '\n' + Array.from(node.children).map((li, i) =>
        `${i + 1}. ${nodeToMarkdown(li).trim()}`
      ).join('\n') + '\n';
    }
    if (tag === 'li') {
      return childrenToMarkdown(node);
    }

    // ── Inline formatting ─────────────────────────────────────────────────────
    if (['strong', 'b'].includes(tag)) return `**${childrenToMarkdown(node)}**`;
    if (['em', 'i'].includes(tag))     return `_${childrenToMarkdown(node)}_`;
    if (tag === 's' || tag === 'del')  return `~~${childrenToMarkdown(node)}~~`;
    if (tag === 'a') {
      const href = node.getAttribute('href');
      const text = childrenToMarkdown(node).trim();
      return href ? `[${text}](${href})` : text;
    }

    // ── Line break ─────────────────────────────────────────────────────────────
    if (tag === 'br') return '\n';

    // ── Horizontal rule ────────────────────────────────────────────────────────
    if (tag === 'hr') return '\n---\n';

    // ── Table (basic) ──────────────────────────────────────────────────────────
    if (tag === 'table') return convertTable(node);

    // ── Default: recurse into children ────────────────────────────────────────
    return childrenToMarkdown(node);
  }

  function childrenToMarkdown(node) {
    return Array.from(node.childNodes).map(nodeToMarkdown).join('');
  }

  function convertTable(table) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (!rows.length) return '';

    const lines = rows.map((row, i) => {
      const cells = Array.from(row.querySelectorAll('td, th'))
        .map(cell => childrenToMarkdown(cell).trim().replace(/\|/g, '\\|'));
      const line = '| ' + cells.join(' | ') + ' |';
      if (i === 0) {
        const sep = '| ' + cells.map(() => '---').join(' | ') + ' |';
        return `${line}\n${sep}`;
      }
      return line;
    });

    return '\n' + lines.join('\n') + '\n';
  }

  // ── Turn extraction ─────────────────────────────────────────────────────────

  /**
   * Classify a turn element as 'user', 'assistant', or null (skip).
   */
  function classifyTurn(element) {
    // Check for user markers
    for (const sel of USER_ROLE_MARKERS) {
      if (element.querySelector(sel) || element.matches(sel)) return 'user';
    }
    // Check for assistant markers
    for (const sel of ASSISTANT_ROLE_MARKERS) {
      if (element.querySelector(sel) || element.matches(sel)) return 'assistant';
    }

    // Heuristic: look at data attributes
    const dataRole = element.getAttribute('data-role') ||
                     element.getAttribute('data-message-role') ||
                     element.getAttribute('data-author-role');
    if (dataRole) return dataRole.toLowerCase().includes('user') ? 'user' : 'assistant';

    // Heuristic: aria-label
    const ariaLabel = (element.getAttribute('aria-label') || '').toLowerCase();
    if (ariaLabel.includes('human') || ariaLabel.includes('user')) return 'user';
    if (ariaLabel.includes('claude') || ariaLabel.includes('assistant')) return 'assistant';

    return null; // cannot classify → skip
  }

  /**
   * Find all turn elements in the DOM, using the first selector that works.
   */
  function findTurnElements() {
    for (const sel of TURN_SELECTORS) {
      const els = Array.from(document.querySelectorAll(sel));
      if (els.length > 0) return els;
    }
    return [];
  }

  /**
   * Given a classified turn element, extract its text content.
   * Skips image-only turns (returns null).
   */
  function extractContent(element, role) {
    // For user turns, look for the message text container
    let contentEl = element;

    if (role === 'user') {
      // Try to find the actual text container
      const candidates = [
        element.querySelector('[data-testid="user-message"]'),
        element.querySelector('[class*="HumanMessage"]'),
        element.querySelector('[class*="user-message-content"]'),
        element.querySelector('p'),    // simplest fallback
        element,
      ].filter(Boolean);
      contentEl = candidates[0];
    } else {
      // Assistant: look for the prose content area
      const candidates = [
        element.querySelector('[class*="prose"]'),
        element.querySelector('[class*="Prose"]'),
        element.querySelector('[class*="markdown"]'),
        element.querySelector('[class*="Markdown"]'),
        element.querySelector('[data-testid="assistant-message"]'),
        element,
      ].filter(Boolean);
      contentEl = candidates[0];
    }

    const markdown = htmlToMarkdown(contentEl);

    // Skip image-only turns (empty after HTML stripping)
    if (!markdown.trim()) return null;

    // Skip artifact/tool-use blocks that are UI elements only
    if (markdown.trim().length < 2) return null;

    return markdown;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Scrape the current conversation from the DOM.
   *
   * @returns {Array<{role: string, content: string, index: number}>}
   */
  function scrapeConversation() {
    const turnElements = findTurnElements();

    if (turnElements.length === 0) {
      console.warn('[ClaudeExt:DomScraper] No turn elements found. DOM may still be loading.');
      return [];
    }

    const turns = [];

    for (const el of turnElements) {
      try {
        const role = classifyTurn(el);
        if (!role) continue;

        const content = extractContent(el, role);
        if (!content) continue;

        turns.push({
          role,
          content: cleanupMarkdown(content),
          index: turns.length,
        });
      } catch (err) {
        console.warn('[ClaudeExt:DomScraper] Error processing turn element:', err);
      }
    }

    return turns;
  }

  /**
   * Final cleanup pass on extracted markdown.
   */
  function cleanupMarkdown(text) {
    return text
      .replace(/\n{4,}/g, '\n\n\n')    // max 3 consecutive newlines
      .replace(/[ \t]+\n/g, '\n')       // trailing spaces on lines
      .replace(/^\n+/, '')              // leading newlines
      .trim();
  }

  /**
   * Get the current conversation ID from the URL.
   * @returns {string}
   */
  function getConversationId() {
    const match = location.pathname.match(/\/chat\/([a-f0-9-]{8,})/i);
    return match ? match[1] : 'unknown';
  }

  return {
    scrapeConversation,
    getConversationId,
    htmlToMarkdown,   // exposed for testing
  };

})();
