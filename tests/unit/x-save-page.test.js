/**
 * Unit tests for the X (Twitter) handling in the save-page Edge Function.
 *
 * X refuses to serve post content to a logged-out server-side fetch: what comes
 * back is a login wall wrapped in a JS shell. Because that wall is the densest
 * run of text on an otherwise <p>-free page, Readability scores it as the
 * article, and an x.com save used to land with "Log in or sign up for X /
 * Relevant people" as its body. save-page therefore never trusts Readability on
 * x.com — it pulls the real post text from X's public embed endpoint instead.
 *
 * supabase/functions/save-page/index.ts is a Deno/TypeScript edge function, so
 * (as in podcast-rss.test.js) the pure helpers are mirrored here and tested in
 * Node. Keep these in sync with the originals.
 */

'use strict';

// ---------------------------------------------------------------------------
// Helpers mirrored from supabase/functions/save-page/index.ts
// ---------------------------------------------------------------------------

const X_HOSTS = ['x.com', 'twitter.com'];

function isXHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^(www|mobile|m)\./, '');
    return X_HOSTS.includes(host);
  } catch {
    return false;
  }
}

function xStatusId(url) {
  try {
    const match = new URL(url).pathname.match(/\/status(?:es)?\/(\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function xPostToArticle(post) {
  const noteText = post?.note_tweet?.note_tweet_results?.result?.text;
  const text = String(noteText || post?.text || '').trim();
  if (!text) return null;

  const images = [
    ...(Array.isArray(post?.photos) ? post.photos.map((p) => p?.url) : []),
    ...(Array.isArray(post?.mediaDetails) ? post.mediaDetails.map((m) => m?.media_url_https) : []),
  ].filter((src) => typeof src === 'string' && src.length > 0);

  const uniqueImages = [...new Set(images)];
  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) || '';
  const handle = post?.user?.screen_name ? `@${post.user.screen_name}` : null;

  return {
    title: firstLine.slice(0, 100) || 'Untitled',
    excerpt: text.replace(/\s+/g, ' ').slice(0, 300),
    content: [text, ...uniqueImages.map((src) => `![](${src})`)].join('\n\n'),
    image_url: uniqueImages[0] || post?.user?.profile_image_url_https || null,
    site_name: 'X',
    author: post?.user?.name || handle,
    published_at: post?.created_at || null,
  };
}

// ---------------------------------------------------------------------------

describe('isXHost', () => {
  test.each([
    'https://x.com/janedev/status/123',
    'https://www.x.com/janedev/status/123',
    'https://mobile.twitter.com/janedev/status/123',
    'https://twitter.com/janedev/article/456',
  ])('recognises %s as X', (url) => {
    expect(isXHost(url)).toBe(true);
  });

  test.each([
    'https://example.com/x.com/article',
    'https://notx.com/janedev/status/123',
    // A lookalike host must not be treated as X — that would send someone
    // else's URL to X's embed endpoint.
    'https://x.com.evil.example/janedev/status/123',
    'not a url',
  ])('does not treat %s as X', (url) => {
    expect(isXHost(url)).toBe(false);
  });
});

describe('xStatusId', () => {
  test('pulls the post id out of a status URL', () => {
    expect(xStatusId('https://x.com/janedev/status/1234567890123456789'))
      .toBe('1234567890123456789');
  });

  test('ignores query strings and trailing paths', () => {
    expect(xStatusId('https://x.com/janedev/status/123/photo/1?s=20')).toBe('123');
  });

  test('handles the legacy /statuses/ form', () => {
    expect(xStatusId('https://twitter.com/janedev/statuses/456')).toBe('456');
  });

  test('returns null for URLs with no post id', () => {
    // Long-form X Articles have no status id — there is nothing for the embed
    // endpoint to look up, so the caller falls back to page metadata.
    expect(xStatusId('https://x.com/janedev/article/987')).toBeNull();
    expect(xStatusId('https://x.com/janedev')).toBeNull();
    expect(xStatusId('nonsense')).toBeNull();
  });
});

describe('xPostToArticle', () => {
  const basePost = {
    text: 'Short post body.',
    created_at: '2026-08-01T14:02:00.000Z',
    user: {
      name: 'Jane Dev',
      screen_name: 'janedev',
      profile_image_url_https: 'https://pbs.twimg.com/profile_images/1/avatar.jpg',
    },
  };

  test('turns a plain post into a readable article record', () => {
    expect(xPostToArticle(basePost)).toEqual({
      title: 'Short post body.',
      excerpt: 'Short post body.',
      content: 'Short post body.',
      image_url: 'https://pbs.twimg.com/profile_images/1/avatar.jpg',
      site_name: 'X',
      author: 'Jane Dev',
      published_at: '2026-08-01T14:02:00.000Z',
    });
  });

  test('prefers the full long-form body over the truncated preview', () => {
    const article = xPostToArticle({
      ...basePost,
      text: 'The opening of a long post that gets cut off here...',
      note_tweet: {
        note_tweet_results: {
          result: { text: 'The opening of a long post\n\nand the rest of it, in full.' },
        },
      },
    });

    expect(article.content).toBe('The opening of a long post\n\nand the rest of it, in full.');
    expect(article.content).not.toContain('cut off here');
    // The title is the opening line, not the whole body.
    expect(article.title).toBe('The opening of a long post');
  });

  test('appends photos as Markdown and de-duplicates the two media fields', () => {
    const article = xPostToArticle({
      ...basePost,
      photos: [{ url: 'https://pbs.twimg.com/media/AAA.jpg' }],
      mediaDetails: [
        { media_url_https: 'https://pbs.twimg.com/media/AAA.jpg' },
        { media_url_https: 'https://pbs.twimg.com/media/BBB.jpg' },
      ],
    });

    expect(article.content).toBe(
      'Short post body.\n\n' +
      '![](https://pbs.twimg.com/media/AAA.jpg)\n\n' +
      '![](https://pbs.twimg.com/media/BBB.jpg)'
    );
    // A real photo beats the author's avatar as the save's cover image.
    expect(article.image_url).toBe('https://pbs.twimg.com/media/AAA.jpg');
  });

  test('falls back to the @handle when the account has no display name', () => {
    const article = xPostToArticle({ ...basePost, user: { screen_name: 'janedev' } });
    expect(article.author).toBe('@janedev');
  });

  test('caps a long opening line so the title stays list-friendly', () => {
    const article = xPostToArticle({ ...basePost, text: 'x'.repeat(400) });
    expect(article.title).toHaveLength(100);
    expect(article.excerpt).toHaveLength(300);
    // The body itself is never truncated.
    expect(article.content).toHaveLength(400);
  });

  test('returns null for a post with no usable text', () => {
    expect(xPostToArticle({ text: '   ', user: basePost.user })).toBeNull();
    expect(xPostToArticle({})).toBeNull();
    expect(xPostToArticle(null)).toBeNull();
  });
});
