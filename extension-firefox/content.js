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
  // X (Twitter) has to be handled before Readability — see extractXPost() for
  // why Readability actively picks the wrong content there.
  if (isXHost(window.location.hostname)) {
    const xPost = extractXPost();
    if (xPost) return xPost;
  }

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

// ---------------------------------------------------------------------------
// X (Twitter) extraction
//
// X's web client is a React SPA whose post text lives in <div data-testid=
// "tweetText"> wrappers built out of <span>s — a whole x.com document contains
// roughly one <p> tag. Readability scores candidates by paragraph density, so
// on x.com it reliably scores the "Log in or sign up for X" wall and the
// "Relevant people" sidebar above the actual post, clears the 200-char bar with
// them, and the save lands full of chrome with none of the article in it. The
// generic fallback path fares no better: its selector list hits
// `article[data-testid="tweet"]` but then looks for p/h1-h6/li/blockquote
// children, of which a tweet has none.
//
// So on X we read X's own DOM directly. These `data-testid` hooks are the ones
// X's client has used consistently and are what every X scraper keys on, but
// they are X's internals, not a contract — extractXPost() returns null on
// anything unexpected so the save falls through to the normal Readability path
// rather than failing.
// ---------------------------------------------------------------------------

const X_HOSTS = ['x.com', 'twitter.com'];

function isXHost(hostname) {
  const host = (hostname || '').toLowerCase().replace(/^(www|mobile|m)\./, '');
  return X_HOSTS.includes(host);
}

// Chrome that lives inside X's primary column and is never article content.
const X_CHROME_SELECTORS = [
  'nav',
  '[role="navigation"]',
  'header[role="banner"]',
  '[data-testid="sidebarColumn"]',
  '[data-testid="BottomBar"]',
  '[data-testid="loginButton"]',
  '[data-testid="signupButton"]',
  '[data-testid="app-bar-back"]',
  '[data-testid="caret"]',
  '[data-testid="inline_reply_offscreen"]',
  '[role="group"]', // the like / repost / share action bar under each post
].join(',');

function xPrimaryColumn() {
  return document.querySelector('[data-testid="primaryColumn"]') ||
         document.querySelector('main[role="main"]') ||
         document.querySelector('main');
}

// The @handle whose post this is, from /<handle>/status/<id> or
// /<handle>/article/<id>. Used to keep other people's replies out of the save.
function xHandleFromUrl() {
  const match = window.location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/(?:status|article)\//);
  return match ? match[1].toLowerCase() : null;
}

function xHandleOfPost(post) {
  const nameEl = post.querySelector('[data-testid="User-Name"]');
  const match = (nameEl?.innerText || '').match(/@([A-Za-z0-9_]{1,15})/);
  return match ? match[1].toLowerCase() : null;
}

// X renders the byline as one block: "Jane Dev @janedev · Aug 1" (sometimes on
// separate lines, sometimes run together). Everything before the @handle is the
// display name.
function xDisplayName() {
  const raw = document.querySelector('[data-testid="User-Name"]')?.innerText?.trim() || '';
  if (!raw) return null;
  return raw.split('@')[0].replace(/[\s·|-]+$/, '').trim() || null;
}

// Collect the thread author's posts in document order. A "post" on X is often
// really a thread, so saving only the focal tweet loses most of the article.
// Replies from other accounts are skipped — they aren't the piece being saved.
function extractXThread() {
  const posts = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  if (!posts.length) return null;

  // Some post URLs carry no handle (/i/web/status/<id>), so fall back to the
  // author of the first post on the page — the root of the thread.
  const author = xHandleFromUrl() || posts.map(xHandleOfPost).find(Boolean) || null;
  const blocks = [];
  const seen = new Set();

  for (const post of posts) {
    const handle = xHandleOfPost(post);
    if (author && handle && handle !== author) continue;

    const textEl = post.querySelector('[data-testid="tweetText"]');
    const text = textEl?.innerText?.trim() || '';
    const images = Array.from(post.querySelectorAll('[data-testid="tweetPhoto"] img[src]'))
      .map(img => resolveImageUrl(img.getAttribute('src')))
      .filter(Boolean)
      .map(src => `![](${src})`);

    if (!text && !images.length) continue;

    // X virtualises the timeline and re-renders the focal post, so the same
    // post can appear twice in the DOM.
    const key = text || images.join('');
    if (seen.has(key)) continue;
    seen.add(key);

    blocks.push([text, ...images].filter(Boolean).join('\n\n'));
  }

  return blocks.length ? blocks.join('\n\n---\n\n') : null;
}

// Long-form X Articles render as a normal rich-text document inside the primary
// column, so once the surrounding chrome is stripped the generic HTML-to-
// Markdown walker handles them.
function extractXArticleBody() {
  const column = xPrimaryColumn();
  if (!column) return null;

  const clone = column.cloneNode(true);
  clone.querySelectorAll(X_CHROME_SELECTORS).forEach(el => el.remove());
  // The byline is captured as the `author` field, so keep it out of the body.
  clone.querySelectorAll('[data-testid="User-Name"]').forEach(el => el.remove());

  const text = htmlToText(clone.innerHTML);
  return text.length > 200 ? text : null;
}

// First real image inside the article body, used as the save's cover when the
// post isn't a photo tweet. Skips X's own avatar/emoji assets.
function xLeadImage() {
  const photo = document.querySelector('[data-testid="tweetPhoto"] img[src]');
  if (photo) return resolveImageUrl(photo.getAttribute('src'));

  const column = xPrimaryColumn();
  const inBody = Array.from(column?.querySelectorAll('img[src]') || [])
    .map(img => resolveImageUrl(img.getAttribute('src')))
    .find(src => src && /\/media\//.test(src));

  return inBody || extractMainImage();
}

// X's og:title is only ever "Name (@handle) on X", which reads as a useless
// title in the library. The opening line of the post is the real headline — for
// an X Article that is literally the article title.
function xTitle(content) {
  const firstLine = content.split('\n').map(s => s.trim()).find(Boolean) || '';
  if (firstLine) {
    return firstLine.length > 100 ? firstLine.slice(0, 97).trimEnd() + '…' : firstLine;
  }
  return document.querySelector('meta[property="og:title"]')?.content?.trim() || document.title;
}

function extractXPost() {
  try {
    const isArticle = /\/article\//.test(window.location.pathname);
    const content = isArticle
      ? (extractXArticleBody() || extractXThread())
      : (extractXThread() || extractXArticleBody());

    if (!content) return null;

    const handle = xHandleFromUrl();
    const flat = content.replace(/\s+/g, ' ').trim();

    return {
      success: true,
      title: xTitle(content),
      content,
      excerpt: flat.length > 300 ? flat.slice(0, 300) + '...' : flat,
      siteName: 'X',
      author: xDisplayName() || (handle ? '@' + handle : null),
      publishedTime: extractPublishedTime(),
      imageUrl: xLeadImage(),
    };
  } catch (e) {
    console.error('X extraction failed:', e);
    return null;
  }
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
        // Images - convert to markdown so they render inline in the reading
        // view (Readability keeps <img> tags in the article HTML; without this
        // they were silently dropped and the save came in text-only).
        else if (tag === 'img') {
          const src = child.getAttribute('src') ||
                      child.getAttribute('data-src') ||
                      child.getAttribute('data-original') ||
                      child.getAttribute('data-lazy-src');
          const absoluteSrc = resolveImageUrl(src);
          if (absoluteSrc) {
            const alt = (child.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
            result += `\n\n![${alt}](${absoluteSrc})\n\n`;
          }
        }
        // Figure / figcaption - keep the image and italicize its caption
        else if (tag === 'figure') {
          result += '\n\n' + processNode(child) + '\n\n';
        }
        else if (tag === 'figcaption') {
          const caption = processNode(child).trim();
          if (caption) result += '\n\n*' + caption + '*\n\n';
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

// Resolve an image src to an absolute URL, skipping empty / inline data URIs.
// Relative paths are resolved against the page so they still load in the app.
function resolveImageUrl(src) {
  if (!src) return null;
  const trimmed = src.trim();
  if (!trimmed || trimmed.startsWith('data:')) return null;
  try {
    return new URL(trimmed, document.baseURI || window.location.href).href;
  } catch (e) {
    return null;
  }
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
