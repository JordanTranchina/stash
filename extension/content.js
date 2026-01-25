// Content script - runs on every page
// Handles article extraction and highlight detection

// Listen for messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'extractArticle') {
    // Handle async extraction
    extractArticle().then(article => {
      sendResponse(article);
    }).catch(err => {
      console.error('Extract error:', err);
      sendResponse(null);
    });
    return true; // Keep channel open for async response
  } else if (request.action === 'getSelection') {
    const selection = window.getSelection().toString().trim();
    sendResponse({ selection });
  }
});

async function extractArticle() {
  try {
    // Clone the document for Readability (it modifies the DOM)
    const documentClone = document.cloneNode(true);
    const reader = new Readability(documentClone, {
      charThreshold: 100,
      classesToPreserve: ['article', 'content', 'post'],
    });
    const article = reader.parse();

    if (article && article.textContent && article.textContent.length > 200) {
      return {
        success: true,
        title: article.title || document.title,
        content: htmlToText(article.content),
        excerpt: article.excerpt || article.textContent?.substring(0, 300) + '...',
        siteName: article.siteName || extractSiteName(),
        author: article.byline,
        publishedTime: extractPublishedTime(),
        imageUrl: extractMainImage(),
      };
    }
  } catch (e) {
    console.error('Readability failed:', e);
  }

  // Fallback: try to find article content more intelligently
  const content = extractFallbackContent();

  return {
    success: true,
    title: document.title,
    content: cleanContent(content),
    excerpt: document.querySelector('meta[name="description"]')?.content ||
             content.substring(0, 300) + '...',
    siteName: extractSiteName(),
    author: extractAuthor(),
    publishedTime: extractPublishedTime(),
    imageUrl: extractMainImage(),
  };
}

function extractFallbackContent() {
  // Try specific article selectors first
  const selectors = [
    'article',
    '[role="article"]',
    '.article-body',
    '.article-content',
    '.post-content',
    '.entry-content',
    '.story-body',
    'main article',
    'main .content',
    '.c-entry-content', // Vox/Verge
    '.article__body',
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) {
      const text = extractTextFromElement(el);
      if (text.length > 500) {
        return text;
      }
    }
  }

  // Fallback: get all paragraphs from main content area
  const mainContent = document.querySelector('main') || document.querySelector('article') || document.body;
  const paragraphs = [];

  mainContent.querySelectorAll('p').forEach(p => {
    const text = p.innerText?.trim();
    // Filter out short paragraphs (likely nav/footer) and common junk
    if (text && text.length > 50 && !isBoilerplate(text)) {
      paragraphs.push(text);
    }
  });

  if (paragraphs.length > 0) {
    return paragraphs.join('\n\n');
  }

  // Last resort: body text, but limited
  return document.body.innerText.substring(0, 50000);
}

function extractTextFromElement(el) {
  const paragraphs = [];
  el.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote').forEach(child => {
    const text = child.innerText?.trim();
    if (text && text.length > 20 && !isBoilerplate(text)) {
      paragraphs.push(text);
    }
  });
  return paragraphs.join('\n\n');
}

function isBoilerplate(text) {
  const lower = text.toLowerCase();
  const boilerplatePatterns = [
    'subscribe',
    'sign up for',
    'newsletter',
    'follow us',
    'share this',
    'related articles',
    'recommended',
    'advertisement',
    'sponsored',
    'cookie',
    'privacy policy',
    'terms of service',
    'all rights reserved',
    'featured video',
    'watch now',
    'read more',
    'see also',
  ];
  return boilerplatePatterns.some(pattern => lower.includes(pattern));
}

function cleanContent(text) {
  if (!text) return '';

  return text
    // Remove excessive whitespace
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    // Remove common UI text patterns
    .replace(/^(Share|Tweet|Email|Print|Save)[\s\n]+/gim, '')
    .replace(/\n(Share|Tweet|Email|Print|Save)\n/gi, '\n')
    // Clean up
    .trim();
}

// Convert HTML to plain text while preserving structure
function htmlToText(html) {
  if (!html) return '';

  // Create a temporary element to parse HTML
  const temp = document.createElement('div');
  temp.innerHTML = html;

  // Process the DOM to preserve formatting
  function processNode(node) {
    let result = '';

    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        result += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();

        // Block elements that need line breaks
        if (['p', 'div', 'article', 'section', 'header', 'footer', 'main'].includes(tag)) {
          result += '\n\n' + processNode(child) + '\n\n';
        }
        // Headings
        else if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
          result += '\n\n' + processNode(child) + '\n\n';
        }
        // Line breaks
        else if (tag === 'br') {
          result += '\n';
        }
        // List items
        else if (tag === 'li') {
          result += '\n• ' + processNode(child);
        }
        // Lists
        else if (['ul', 'ol'].includes(tag)) {
          result += '\n' + processNode(child) + '\n';
        }
        // Blockquotes
        else if (tag === 'blockquote') {
          const text = processNode(child).trim().split('\n').map(line => '> ' + line).join('\n');
          result += '\n\n' + text + '\n\n';
        }
        // Links - convert to markdown
        else if (tag === 'a') {
          const href = child.getAttribute('href');
          const text = processNode(child).trim();
          if (href && text && !href.startsWith('#') && !href.startsWith('javascript:')) {
            // Make relative URLs absolute
            const absoluteUrl = href.startsWith('http') ? href : new URL(href, window.location.origin).href;
            result += `[${text}](${absoluteUrl})`;
          } else {
            result += text;
          }
        }
        // Bold
        else if (['strong', 'b'].includes(tag)) {
          result += '**' + processNode(child) + '**';
        }
        // Italic
        else if (['em', 'i'].includes(tag)) {
          result += '*' + processNode(child) + '*';
        }
        // Code
        else if (tag === 'code') {
          result += '`' + processNode(child) + '`';
        }
        // Pre/code blocks
        else if (tag === 'pre') {
          result += '\n\n```\n' + processNode(child) + '\n```\n\n';
        }
        // Skip script, style, etc.
        else if (['script', 'style', 'noscript', 'iframe'].includes(tag)) {
          // Skip
        }
        // Other inline elements
        else {
          result += processNode(child);
        }
      }
    }

    return result;
  }

  let text = processNode(temp);

  // Clean up excessive whitespace while preserving intentional line breaks
  text = text
    .replace(/[ \t]+/g, ' ')           // Collapse horizontal whitespace
    .replace(/\n[ \t]+/g, '\n')        // Remove leading spaces on lines
    .replace(/[ \t]+\n/g, '\n')        // Remove trailing spaces on lines
    .replace(/\n{3,}/g, '\n\n')        // Max 2 consecutive newlines
    .trim();

  return text;
}

function extractAuthor() {
  return document.querySelector('meta[name="author"]')?.content ||
         document.querySelector('meta[property="article:author"]')?.content ||
         document.querySelector('[rel="author"]')?.innerText?.trim() ||
         document.querySelector('.author, .byline, .author-name')?.innerText?.trim() ||
         null;
}

function extractSiteName() {
  return document.querySelector('meta[property="og:site_name"]')?.content ||
         document.querySelector('meta[name="application-name"]')?.content ||
         window.location.hostname.replace('www.', '');
}

function extractPublishedTime() {
  const timeEl = document.querySelector('time[datetime]');
  if (timeEl) return timeEl.getAttribute('datetime');

  const metaTime = document.querySelector('meta[property="article:published_time"]')?.content;
  if (metaTime) return metaTime;

  return null;
}

function extractMainImage() {
  return document.querySelector('meta[property="og:image"]')?.content ||
         document.querySelector('meta[name="twitter:image"]')?.content ||
         null;
}

// Show save confirmation toast
function showToast(message, isError = false) {
  const existing = document.getElementById('stash-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'stash-toast';
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    padding: 12px 24px;
    background: ${isError ? '#ef4444' : '#10b981'};
    color: white;
    border-radius: 8px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    font-weight: 500;
    z-index: 999999;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    animation: stashSlideIn 0.3s ease;
  `;

  const style = document.createElement('style');
  style.textContent = `
    @keyframes stashSlideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'stashSlideIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

// Listen for save confirmations
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'showToast') {
    showToast(request.message, request.isError);
  }
});
